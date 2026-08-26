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

await test('registry exposes generate_image', async () => {
  const registry = createToolRegistry();
  assert.ok(registry.has('generate_image'));
  assert.ok(registry.list().some(tool => tool.name === 'generate_image'));
});

await test('generate_image calls image endpoint and writes file', async () => {
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  const oldEnv = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    BAHULAM_IMAGE_GENERATION_MODEL: process.env.BAHULAM_IMAGE_GENERATION_MODEL,
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-generate-image-'));
  const b64 = Buffer.from('fake-png-bytes').toString('base64');
  const captured = {};

  try {
    process.chdir(tmp);
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
          return JSON.stringify({
            data: [{ b64_json: b64, media_type: 'image/png' }],
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
    assert.strictEqual(captured.url, 'https://openrouter.example/api/v1/images');
    assert.deepStrictEqual(captured.body, {
      model: 'test/image-model',
      prompt: 'A blue app icon',
      aspect_ratio: '1:1',
      quality: 'high',
    });
    assert.strictEqual(captured.headers.Authorization, 'Bearer or_test');
    assert.strictEqual(result.images[0].path, path.join(fs.realpathSync(tmp), 'assets', 'icon.png'));
    assert.strictEqual(fs.readFileSync(result.images[0].path, 'utf8'), 'fake-png-bytes');
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('tool executor bridges generate_image calls', async () => {
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  const oldEnv = {
    BAHULAM_SKIP_AUTO_REGISTER: process.env.BAHULAM_SKIP_AUTO_REGISTER,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    BAHULAM_IMAGE_GENERATION_MODEL: process.env.BAHULAM_IMAGE_GENERATION_MODEL,
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-generate-image-bridge-'));
  const b64 = Buffer.from('bridge-png-bytes').toString('base64');

  try {
    process.chdir(tmp);
    process.env.BAHULAM_SKIP_AUTO_REGISTER = 'true';
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
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log(`\n${passed} test(s) passed`);
