/**
 * Tests for plugin lifecycle — seed / post_install / pre_uninstall /
 * migrations, plus manifest normalization + preflight validation.
 *
 * Each case runs in an isolated tmp $HOME so ~/.bahulam/data/ never
 * touches the user's real state. State-DB tests are skipped when
 * node:sqlite isn't available (SQL migrations need it).
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Suppress lifecycle's console mirror so test output stays scannable.
process.env.BAHULAM_LIFECYCLE_QUIET = '1';

import { normalizeManifest } from '../src/plugins/manifest.mjs';
import { preflightPlugin } from '../src/plugins/preflight.mjs';
import {
  runSeed,
  runPostInstall,
  runPreUninstall,
  runMigrations,
  purgeData,
  readLifecycleRecord,
} from '../src/plugins/lifecycle.mjs';
import { makePluginState, _resetForTests } from '../src/plugins/state.mjs';

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-lifecycle-'));
  const savedHome = process.env.HOME;
  process.env.HOME = tmp;
  _resetForTests();
  try {
    const r = await fn(tmp);
    if (r === 'skip') { console.log(`  \x1b[33m-\x1b[0m ${name} (skipped)`); skipped++; }
    else { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Build a self-contained plugin dir on disk. Hooks are inline strings.
function scaffoldPlugin(tmp, { name = 'lifecycle-test', version = '0.1.0', hooks = {}, migrations = [], state = null } = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });

  const lifecycle = {};
  for (const [key, code] of Object.entries(hooks)) {
    const rel = `./hooks/${key}.mjs`;
    fs.writeFileSync(path.join(dir, 'hooks', `${key}.mjs`), code);
    lifecycle[key] = rel;
  }
  if (migrations.length) {
    lifecycle.migrations = migrations.map((m) => {
      const entry = { version: m.version };
      const rel = `./migrations/${m.version}.${m.sql ? 'sql' : 'mjs'}`;
      if (m.sql) { fs.writeFileSync(path.join(dir, 'migrations', `${m.version}.sql`), m.sql); entry.sql = rel; }
      else if (m.run) { fs.writeFileSync(path.join(dir, 'migrations', `${m.version}.mjs`), m.run); entry.run = rel; }
      return entry;
    });
  }

  const manifest = {
    apiVersion: 'bahulam.plugin/1',
    kind: 'Plugin',
    metadata: { name, version, description: 'test', author: 'test' },
    config: {
      tools: [],
      ...(Object.keys(lifecycle).length ? { lifecycle } : {}),
      ...(state ? { state } : {}),
    },
  };
  const yamlPath = path.join(dir, 'plugin.json');
  fs.writeFileSync(yamlPath, JSON.stringify(manifest, null, 2));
  return { dir, manifest: normalizeManifest(manifest, yamlPath) };
}

// ── Manifest normalization ──────────────────────────────────────────────

console.log('\n\x1b[1mtest-plugin-lifecycle.mjs\x1b[0m\n');

await test('normalizeManifest reads config.lifecycle when present', async (tmp) => {
  const { manifest } = scaffoldPlugin(tmp, {
    hooks: { seed: 'export async function run(ctx) {}' },
    migrations: [{ version: '0.2.0', run: 'export async function run(ctx) {}' }],
  });
  assert.ok(manifest.config.lifecycle, 'lifecycle should be present');
  assert.strictEqual(manifest.config.lifecycle.seed, './hooks/seed.mjs');
  assert.strictEqual(manifest.config.lifecycle.migrations.length, 1);
  assert.strictEqual(manifest.config.lifecycle.migrations[0].version, '0.2.0');
});

await test('normalizeManifest omits lifecycle when not declared', async (tmp) => {
  const { manifest } = scaffoldPlugin(tmp);
  assert.strictEqual(manifest.config.lifecycle, undefined);
});

// ── Preflight validation ────────────────────────────────────────────────

await test('preflight passes with a valid seed hook', async (tmp) => {
  const { dir } = scaffoldPlugin(tmp, { hooks: { seed: 'export async function run(ctx) {}' } });
  const r = await preflightPlugin(dir, { existingPluginNames: () => [] });
  assert.strictEqual(r.ok, true, `expected ok; errors: ${JSON.stringify(r.errors)}`);
});

await test('preflight fails when seed hook file is missing', async (tmp) => {
  const dir = path.join(tmp, 'bad-hook');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    apiVersion: 'bahulam.plugin/1',
    kind: 'Plugin',
    metadata: { name: 'bad-hook', version: '0.1.0', description: 'x', author: 'x' },
    config: { tools: [], lifecycle: { seed: './hooks/missing.mjs' } },
  }));
  const r = await preflightPlugin(dir, { existingPluginNames: () => [] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /seed hook not found/.test(e)), `errors: ${JSON.stringify(r.errors)}`);
});

await test('preflight rejects a migration that supplies both sql and run', async (tmp) => {
  const dir = path.join(tmp, 'both-sql-run');
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'migrations', '0.2.0.sql'), 'SELECT 1;');
  fs.writeFileSync(path.join(dir, 'migrations', '0.2.0.mjs'), 'export async function run(ctx) {}');
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    apiVersion: 'bahulam.plugin/1',
    kind: 'Plugin',
    metadata: { name: 'both-sql-run', version: '0.1.0', description: 'x', author: 'x' },
    config: { tools: [], lifecycle: { migrations: [
      { version: '0.2.0', sql: './migrations/0.2.0.sql', run: './migrations/0.2.0.mjs' },
    ] } },
  }));
  const r = await preflightPlugin(dir, { existingPluginNames: () => [] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /only one of sql or run/.test(e)), `errors: ${JSON.stringify(r.errors)}`);
});

// ── Runners ─────────────────────────────────────────────────────────────

await test('runSeed runs once, is skipped on second call without force', async (tmp) => {
  const { dir, manifest } = scaffoldPlugin(tmp, {
    hooks: { seed: `
      export async function run(ctx) {
        ctx.log('info', 'seed ran');
        return { seeded: 42 };
      }
    ` },
  });
  const r1 = await runSeed({ pluginName: manifest.metadata.name, pluginDir: dir, manifest });
  assert.strictEqual(r1.ran, true);
  const r2 = await runSeed({ pluginName: manifest.metadata.name, pluginDir: dir, manifest });
  assert.strictEqual(r2.ran, false);
  assert.match(r2.reason, /already ran/);
  const rec = readLifecycleRecord(manifest.metadata.name);
  assert.ok(rec.runs.seed, 'runs.seed should be recorded');
});

await test('runSeed re-runs when force=true', async (tmp) => {
  const { dir, manifest } = scaffoldPlugin(tmp, {
    hooks: { seed: 'export async function run(ctx) {}' },
  });
  await runSeed({ pluginName: manifest.metadata.name, pluginDir: dir, manifest });
  const r2 = await runSeed({ pluginName: manifest.metadata.name, pluginDir: dir, manifest, args: { force: true } });
  assert.strictEqual(r2.ran, true);
});

await test('runPostInstall stamps installed_at + installed_version on first run', async (tmp) => {
  const { dir, manifest } = scaffoldPlugin(tmp, {
    version: '1.2.3',
    hooks: { post_install: 'export async function run(ctx) {}' },
  });
  await runPostInstall({ pluginName: manifest.metadata.name, pluginDir: dir, manifest });
  const rec = readLifecycleRecord(manifest.metadata.name);
  assert.ok(rec.installed_at, 'installed_at should be set');
  assert.strictEqual(rec.installed_version, '1.2.3');
});

await test('runPreUninstall receives ctx and can return keepData', async (tmp) => {
  const { dir, manifest } = scaffoldPlugin(tmp, {
    hooks: { pre_uninstall: `
      export async function run(ctx) {
        return { keepData: true, warnings: ['snapshot exported'] };
      }
    ` },
  });
  const r = await runPreUninstall({ pluginName: manifest.metadata.name, pluginDir: dir, manifest });
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.result.keepData, true);
  assert.deepStrictEqual(r.result.warnings, ['snapshot exported']);
});

// ── Migrations ──────────────────────────────────────────────────────────

await test('runMigrations applies pending JS migrations in order', async (tmp) => {
  const { dir, manifest } = scaffoldPlugin(tmp, {
    migrations: [
      { version: '0.2.0', run: `
        export async function run(ctx) { ctx.log('info', 'mig 0.2.0'); }
      ` },
      { version: '0.3.0', run: `
        export async function run(ctx) { ctx.log('info', 'mig 0.3.0'); }
      ` },
    ],
  });
  const r1 = await runMigrations({ pluginName: manifest.metadata.name, pluginDir: dir, manifest });
  assert.strictEqual(r1.ran, 2);
  const r2 = await runMigrations({ pluginName: manifest.metadata.name, pluginDir: dir, manifest });
  assert.strictEqual(r2.ran, 0, 'no re-runs on the second call');
  const rec = readLifecycleRecord(manifest.metadata.name);
  assert.deepStrictEqual(rec.applied_migrations, ['0.2.0', '0.3.0']);
});

await test('runMigrations rolls back applied_migrations on mid-batch failure', async (tmp) => {
  const { dir, manifest } = scaffoldPlugin(tmp, {
    migrations: [
      { version: '0.2.0', run: 'export async function run(ctx) {}' },
      { version: '0.3.0', run: 'export async function run(ctx) { throw new Error("boom"); }' },
    ],
  });
  await assert.rejects(
    runMigrations({ pluginName: manifest.metadata.name, pluginDir: dir, manifest }),
    /boom/,
  );
  const rec = readLifecycleRecord(manifest.metadata.name);
  // 0.2.0 succeeded pre-throw — snapshot rollback should strip it too.
  assert.strictEqual(rec.applied_migrations.includes('0.3.0'), false, '0.3.0 must not be marked applied');
});

// ── Data purge ──────────────────────────────────────────────────────────

await test('purgeData removes the data dir', async (tmp) => {
  const dir = path.join(tmp, '.bahulam', 'data', 'purgeme');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trash'), 'x');
  const r = purgeData('purgeme');
  assert.strictEqual(r.purged, true);
  assert.strictEqual(fs.existsSync(dir), false);
});

await test('purgeData is a no-op when dir is absent', async () => {
  const r = purgeData('never-existed-xyz');
  assert.strictEqual(r.purged, false);
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n  \x1b[32m${passed} passed\x1b[0m${failed ? `, \x1b[31m${failed} failed\x1b[0m` : ''}${skipped ? `, \x1b[33m${skipped} skipped\x1b[0m` : ''}\n`);
if (failed) process.exit(1);
