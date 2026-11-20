import assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { optionRowsForRole, pickModelOverridesForm } from '../src/terminal/repl-model-form.mjs';
import { isFreeModel, modelMatchesTextFilter } from '../src/terminal/model-catalog-display.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

console.log('\n\x1b[1mtest-repl-model-form.mjs\x1b[0m\n');

test('text role options include non-curated multimodal catalog rows', () => {
  const catalog = [
    {
      id: 'deepseek/deepseek-v4.1-flash',
      label: 'DeepSeek: DeepSeek V4.1 Flash',
      provider: 'deepseek',
      category: 'multimodal',
      harness_validated: false,
    },
    {
      id: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      provider: 'deepseek',
      category: 'text',
      harness_validated: true,
    },
    {
      id: 'google/gemini-3-pro-image',
      label: 'Gemini 3 Pro Image',
      provider: 'google',
      category: 'image',
      harness_validated: true,
    },
  ];
  const rows = optionRowsForRole(catalog, { optionGroup: 'text' });
  assert.deepStrictEqual(rows.map(row => row.id), [
    'deepseek/deepseek-v4.1-flash',
    'deepseek/deepseek-v4-flash',
  ]);
});

test('image generation options still stay in the image generation group', () => {
  const catalog = [
    {
      id: 'deepseek/deepseek-v4.1-flash',
      label: 'DeepSeek: DeepSeek V4.1 Flash',
      provider: 'deepseek',
      category: 'multimodal',
      harness_validated: false,
    },
    {
      id: 'google/gemini-3-pro-image',
      label: 'Gemini 3 Pro Image',
      provider: 'google',
      category: 'image',
      harness_validated: true,
    },
  ];
  const rows = optionRowsForRole(catalog, { optionGroup: 'image_generation' });
  assert.deepStrictEqual(rows.map(row => row.id), ['google/gemini-3-pro-image']);
});

// ── Filter predicates for the searchable picker ───────────────────────────

test('isFreeModel true when both costs missing/zero', () => {
  assert.strictEqual(isFreeModel({ input_cost_usd_per_m: 0, output_cost_usd_per_m: 0 }), true);
  assert.strictEqual(isFreeModel({ input_cost_usd_per_m: null, output_cost_usd_per_m: null }), true);
  assert.strictEqual(isFreeModel({}), true);
});

test('isFreeModel false when either cost present', () => {
  assert.strictEqual(isFreeModel({ input_cost_usd_per_m: 1.5, output_cost_usd_per_m: 0 }), false);
  assert.strictEqual(isFreeModel({ input_cost_usd_per_m: 0, output_cost_usd_per_m: 0.5 }), false);
});

test('modelMatchesTextFilter matches id/label/provider substring', () => {
  const m = { id: 'deepseek/deepseek-v4', label: 'DeepSeek V4', provider: 'deepseek' };
  assert.strictEqual(modelMatchesTextFilter(m, 'deep'), true);
  assert.strictEqual(modelMatchesTextFilter(m, 'v4'), true);
  assert.strictEqual(modelMatchesTextFilter(m, 'openai'), false);
});

test('modelMatchesTextFilter matches capability keywords', () => {
  assert.strictEqual(modelMatchesTextFilter({ id: 'm', supports_tools: true }, 'tools'), true);
  assert.strictEqual(modelMatchesTextFilter({ id: 'm', supports_tools: false }, 'tools'), false);
  assert.strictEqual(modelMatchesTextFilter({ id: 'm', supports_reasoning: true }, 'reasoning'), true);
  assert.strictEqual(modelMatchesTextFilter({ id: 'm', harness_validated: true }, 'curated'), true);
  assert.strictEqual(modelMatchesTextFilter({ id: 'm', harness_validated: false }, 'curated'), false);
});

test('modelMatchesTextFilter free keyword', () => {
  assert.strictEqual(modelMatchesTextFilter({ id: 'm', input_cost_usd_per_m: 0, output_cost_usd_per_m: 0 }, 'free'), true);
  assert.strictEqual(modelMatchesTextFilter({ id: 'm', input_cost_usd_per_m: 1, output_cost_usd_per_m: 0 }, 'free'), false);
});

test('modelMatchesTextFilter ANDs tokens', () => {
  const m = {
    id: 'deepseek/x', label: 'DeepSeek', provider: 'deepseek',
    supports_tools: true, harness_validated: true,
    input_cost_usd_per_m: 0, output_cost_usd_per_m: 0,
  };
  assert.strictEqual(modelMatchesTextFilter(m, 'deep free'), true);
  assert.strictEqual(modelMatchesTextFilter(m, 'deepseek curated tools'), true);
  assert.strictEqual(modelMatchesTextFilter(m, 'deepseek reasoning'), false);
});

test('modelMatchesTextFilter empty query matches everything', () => {
  assert.strictEqual(modelMatchesTextFilter({ id: 'x' }, ''), true);
  assert.strictEqual(modelMatchesTextFilter({ id: 'x' }, null), true);
});

// Send the whole filter and its controls in one raw input chunk, as paste and
// fast typists can do. Exercise the picker itself, including the empty state.
const input = new PassThrough();
input.isTTY = true;
input.setRawMode = raw => { input.isRaw = raw; };
const write = process.stderr.write;
let output = '';
try {
  process.stderr.write = chunk => { output += String(chunk); return true; };
  const picked = pickModelOverridesForm({
    input, roles: [{ role: 'coder' }, { role: 'planner' }],
    catalog: [{ id: 'qwen/coder', category: 'text', harness_validated: true }],
  });
  input.write('no-match');
  input.write('\x12qwen curated free=\r');
  assert.deepEqual(await picked, { overrides: { coder: 'qwen/coder' } });
  assert.ok(output.includes('no models match'));
  assert.equal(input.isRaw, false);
  passed++;
} finally {
  process.stderr.write = write;
  input.destroy();
}

console.log(`\n\x1b[32m${passed} passed\x1b[0m\n`);
