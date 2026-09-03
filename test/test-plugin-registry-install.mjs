import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registryNameFromSource,
  resolveBahulamRegistryPlugin,
} from '../src/commands/install.mjs';
import { classifySource } from '../src/commands/plugin-manage.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    })
    .catch(err => {
      console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.stack || err.message}`);
      failed++;
    });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-plugin-registry-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

console.log('\n\x1b[1mtest-plugin-registry-install.mjs\x1b[0m\n');

await test('detects bare and bahulam-prefixed registry names', async () => {
  assert.strictEqual(registryNameFromSource('manim-studio', { kind: 'name', name: 'manim-studio' }), 'manim-studio');
  assert.strictEqual(registryNameFromSource('bahulam:manim-studio', classifySource('bahulam:manim-studio')), 'manim-studio');
  assert.strictEqual(registryNameFromSource('pi:pi-web-access', classifySource('pi:pi-web-access')), null);
});

await test('resolves plugins from a registry file', async () => {
  await withTempDir(async (dir) => {
    const registryPath = path.join(dir, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      plugins: [
        {
          name: 'manim-studio',
          repository: 'https://github.com/BahulamAI/awesome-bahulam-plugins',
          ref: 'main',
          subdir: 'plugins/manim-studio',
          aliases: ['manim'],
        },
      ],
    }, null, 2));

    const previous = process.env.BAHULAM_PLUGIN_REGISTRY;
    process.env.BAHULAM_PLUGIN_REGISTRY = registryPath;
    try {
      const entry = await resolveBahulamRegistryPlugin('bahulam:manim-studio', { cwd: dir });
      assert.strictEqual(entry.name, 'manim-studio');
      assert.strictEqual(entry.repository, 'https://github.com/BahulamAI/awesome-bahulam-plugins');
      assert.strictEqual(entry.ref, 'main');
      assert.strictEqual(entry.subdir, 'plugins/manim-studio');

      const aliasEntry = await resolveBahulamRegistryPlugin('manim', { cwd: dir });
      assert.strictEqual(aliasEntry.name, 'manim-studio');
    } finally {
      if (previous === undefined) delete process.env.BAHULAM_PLUGIN_REGISTRY;
      else process.env.BAHULAM_PLUGIN_REGISTRY = previous;
    }
  });
});

await test('reports available plugin names when a registry lookup misses', async () => {
  await assert.rejects(
    () => resolveBahulamRegistryPlugin('missing', {
      registry: { plugins: [{ name: 'manim-studio' }] },
    }),
    /plugin not found in Bahulam registry: missing[\s\S]*manim-studio/,
  );
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
