import assert from 'node:assert';
import { optionRowsForRole } from '../src/terminal/repl-model-form.mjs';

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

console.log(`\n\x1b[32m${passed} passed\x1b[0m\n`);
