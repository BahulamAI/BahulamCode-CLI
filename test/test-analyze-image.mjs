import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createToolExecutor } from '../src/core/tool-executor.mjs';
import { createToolRegistry } from '../src/tools/registry.mjs';
import { AnalyzeImageTool } from '../src/tools/analyze-image.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
    failed++;
  }
}

function writePng(filePath) {
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
  );
  fs.writeFileSync(filePath, png1x1);
}

function saveEnv(keys) {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log('\n\x1b[1mtest-analyze-image.mjs\x1b[0m\n');

await test('registry exposes analyze_image', async () => {
  const registry = createToolRegistry();
  assert.ok(registry.has('analyze_image'));
  assert.ok(registry.list().some(tool => tool.name === 'analyze_image'));
});

await test('shipped catalog includes DeepSeek vision default', async () => {
  const catalog = JSON.parse(fs.readFileSync(
    new URL('../src/config/model-catalog-default.json', import.meta.url),
    'utf8',
  ));
  const row = catalog.models.find(model => model.value === 'deepseek/deepseek-v4-flash-vision-exp');
  assert.ok(row);
  assert.strictEqual(row.inputCost, 0.22);
  assert.strictEqual(row.outputCost, 0.66);
  assert.strictEqual(row.context, 1048576);
  assert.strictEqual(row.maxOutput, 384000);
  assert.deepStrictEqual(row.platformAccessTier, ['free', 'pro', 'tier_49', 'tier_99']);
});

await test('analyze_image calls authenticated backend vision endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  const env = saveEnv(['BAHULAM_HOME', 'B0_TOKEN', 'TARANG_BACKEND_URL', 'BAHULAM_PRODUCT']);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-analyze-image-'));
  const file = path.join(tmp, 'one.png');
  const captured = {};

  try {
    writePng(file);
    process.chdir(tmp);
    process.env.BAHULAM_HOME = path.join(tmp, 'home');
    process.env.B0_TOKEN = 'cli_test_token';
    process.env.TARANG_BACKEND_URL = 'https://backend.example';
    process.env.BAHULAM_PRODUCT = 'bahulam';
    globalThis.fetch = async (url, options) => {
      captured.url = url;
      captured.headers = options.headers;
      captured.body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            summary: 'The image is a single transparent pixel.',
            model: 'vision-model',
            attachments: [{ name: 'one.png', mime_type: 'image/png', width: 1, height: 1 }],
            usage: { input_tokens: 12 },
          });
        },
      };
    };

    const result = await AnalyzeImageTool.call({
      path: file,
      question: 'Describe the image.',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'The image is a single transparent pixel.');
    assert.strictEqual(captured.url, 'https://backend.example/api/vision/analyze');
    assert.strictEqual(captured.headers.Authorization, 'Bearer cli_test_token');
    assert.strictEqual(captured.headers['X-Product'], 'bahulam');
    assert.strictEqual(captured.body.instruction, 'Describe the image.');
    assert.strictEqual(captured.body.attachments.length, 1);
    assert.strictEqual(captured.body.attachments[0].mime_type, 'image/png');
    assert.ok(captured.body.attachments[0].data_base64);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    restoreEnv(env);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('tool executor bridges analyze_image calls', async () => {
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  const env = saveEnv(['BAHULAM_HOME', 'BAHULAM_SKIP_AUTO_REGISTER', 'B0_TOKEN', 'TARANG_BACKEND_URL']);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-analyze-image-bridge-'));
  const file = path.join(tmp, 'one.png');

  try {
    writePng(file);
    process.chdir(tmp);
    process.env.BAHULAM_HOME = path.join(tmp, 'home');
    process.env.BAHULAM_SKIP_AUTO_REGISTER = 'true';
    process.env.B0_TOKEN = 'cli_test_token';
    process.env.TARANG_BACKEND_URL = 'https://backend.example';
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ summary: 'Bridge summary.', model: 'vision-model' });
      },
    });

    const executor = createToolExecutor();
    const result = await executor.execute('analyze_image', {
      path: file,
      question: 'What is shown?',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result._tool, 'analyze_image');
    assert.strictEqual(result.output, 'Bridge summary.');
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    restoreEnv(env);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log(`\n${passed} test(s) passed`);
