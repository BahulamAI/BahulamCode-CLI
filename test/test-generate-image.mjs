import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createToolExecutor } from '../src/core/tool-executor.mjs';
import { createToolRegistry } from '../src/tools/registry.mjs';
import { GenerateImageTool } from '../src/tools/generate-image.mjs';

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

console.log('\n\x1b[1mtest-generate-image.mjs\x1b[0m\n');

function saveEnv(keys) {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

await test('registry exposes generate_image', async () => {
  const registry = createToolRegistry();
  assert.ok(registry.has('generate_image'));
  assert.ok(registry.list().some(tool => tool.name === 'generate_image'));
});

await test('generate_image calls authenticated backend and writes file', async () => {
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  const oldEnv = saveEnv([
    'BAHULAM_HOME',
    'B0_TOKEN',
    'KEPLER_TOKEN',
    'TARANG_BACKEND_URL',
    'BAHULAM_PRODUCT',
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'BAHULAM_GATEWAY_API_KEY',
    'BAHULAM_IMAGE_GENERATION_MODEL',
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-generate-image-'));
  const b64 = Buffer.from('fake-png-bytes').toString('base64');
  const captured = {};

  try {
    process.chdir(tmp);
    process.env.BAHULAM_HOME = path.join(tmp, 'home');
    process.env.B0_TOKEN = 'cli_test_token';
    delete process.env.KEPLER_TOKEN;
    process.env.TARANG_BACKEND_URL = 'https://backend.example';
    process.env.BAHULAM_PRODUCT = 'bahulam';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.BAHULAM_GATEWAY_API_KEY;
    delete process.env.BAHULAM_IMAGE_GENERATION_MODEL;
    globalThis.fetch = async (url, options) => {
      captured.url = url;
      captured.body = JSON.parse(options.body);
      captured.headers = options.headers;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            images: [{ data_url: `data:image/png;base64,${b64}`, mime: 'image/png' }],
            model: 'backend/image-model',
            provider: 'bahulam',
            usage: { cost: 0.01 },
          });
        },
      };
    };

    const result = await GenerateImageTool.call({
      prompt: 'A blue app icon',
      output_path: 'assets/icon.png',
      aspect_ratio: '1:1',
      quality: 'high',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(captured.url, 'https://backend.example/api/images/generate');
    assert.deepStrictEqual(captured.body, {
      prompt: 'A blue app icon',
      include_data_url: true,
      aspect_ratio: '1:1',
      quality: 'high',
      output_path: 'assets/icon.png',
    });
    assert.strictEqual(captured.headers.Authorization, 'Bearer cli_test_token');
    assert.strictEqual(captured.headers['X-Product'], 'bahulam');
    assert.strictEqual(result.model, 'backend/image-model');
    assert.strictEqual(result.provider, 'bahulam');
    assert.strictEqual(result.images[0].path, path.join(fs.realpathSync(tmp), 'assets', 'icon.png'));
    assert.strictEqual(fs.readFileSync(result.images[0].path, 'utf8'), 'fake-png-bytes');
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    restoreEnv(oldEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('generate_image falls back to direct image endpoint with provider key', async () => {
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  const oldEnv = saveEnv([
    'BAHULAM_HOME',
    'B0_TOKEN',
    'KEPLER_TOKEN',
    'TARANG_BACKEND_URL',
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'BAHULAM_IMAGE_GENERATION_MODEL',
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-generate-image-direct-'));
  const b64 = Buffer.from('direct-png-bytes').toString('base64');
  const captured = {};

  try {
    process.chdir(tmp);
    process.env.BAHULAM_HOME = path.join(tmp, 'home');
    delete process.env.B0_TOKEN;
    delete process.env.KEPLER_TOKEN;
    process.env.OPENROUTER_API_KEY = 'or_test';
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.example/api/v1';
    process.env.BAHULAM_IMAGE_GENERATION_MODEL = 'test/image-model';
    globalThis.fetch = async (url, options) => {
      captured.url = url;
      captured.body = JSON.parse(options.body);
      captured.headers = options.headers;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ data: [{ b64_json: b64, media_type: 'image/png' }] });
        },
      };
    };

    const result = await GenerateImageTool.call({
      prompt: 'A local fallback icon',
      output_path: 'assets/icon.png',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(captured.url, 'https://openrouter.example/api/v1/images');
    assert.strictEqual(captured.body.model, 'test/image-model');
    assert.strictEqual(captured.headers.Authorization, 'Bearer or_test');
    assert.strictEqual(result.provider, 'openrouter-compatible');
    assert.strictEqual(fs.readFileSync(result.images[0].path, 'utf8'), 'direct-png-bytes');
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    restoreEnv(oldEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('tool executor bridges generate_image calls', async () => {
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  const oldEnv = saveEnv([
    'BAHULAM_HOME',
    'BAHULAM_SKIP_AUTO_REGISTER',
    'B0_TOKEN',
    'KEPLER_TOKEN',
    'TARANG_BACKEND_URL',
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'BAHULAM_IMAGE_GENERATION_MODEL',
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-generate-image-bridge-'));
  const b64 = Buffer.from('bridge-png-bytes').toString('base64');

  try {
    process.chdir(tmp);
    process.env.BAHULAM_HOME = path.join(tmp, 'home');
    process.env.BAHULAM_SKIP_AUTO_REGISTER = 'true';
    delete process.env.B0_TOKEN;
    delete process.env.KEPLER_TOKEN;
    process.env.OPENROUTER_API_KEY = 'or_test';
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.example/api/v1';
    process.env.BAHULAM_IMAGE_GENERATION_MODEL = 'test/image-model';
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ data: [{ b64_json: b64, media_type: 'image/png' }] });
      },
    });

    const executor = createToolExecutor();
    const result = await executor.execute('generate_image', {
      prompt: 'A local bridge icon',
      output_path: 'generated/icon.png',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result._tool, 'generate_image');
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'generated', 'icon.png'), 'utf8'), 'bridge-png-bytes');
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    restoreEnv(oldEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log(`\n${passed} test(s) passed`);
