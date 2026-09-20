/** Remember bridge + disk persistence regressions; no real home or network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const reloading = process.argv[2] === '--reload';
const fixture = reloading ? process.argv[3] : fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-remember-'));
const project = path.join(fixture, 'project');
const otherProject = path.join(fixture, 'other-project');
const testHome = path.join(fixture, 'user');
const original = { cwd: process.cwd(), homedir: os.homedir, statSync: fs.statSync, writeFileSync: fs.writeFileSync, fetch: globalThis.fetch };
const envKeys = ['BAHULAM_HOME', 'BAHULAM_SKIP_AUTO_REGISTER', 'BAHULAM_DISABLE_TELEMETRY'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
// memory-disk deliberately uses os.homedir(), not BAHULAM_HOME. Redirect both
// in this isolated test process without changing the user's HOME variable.
os.homedir = () => testHome;
syncBuiltinESMExports();
process.env.BAHULAM_HOME = path.join(testHome, '.bahulam');
process.env.BAHULAM_SKIP_AUTO_REGISTER = 'true';
process.env.BAHULAM_DISABLE_TELEMETRY = '1';
globalThis.fetch = async () => { throw new Error('Unexpected network access in memory test'); };

const longContent = 'Fixture /chat initialization findings: ' + 'Per-upload resolution should be batched. '.repeat(12) + '\nMCP setup is separate; keep the complete finding — 中文.';
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}

try {
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(otherProject, { recursive: true });
  process.chdir(project);
  const { createToolExecutor } = await import('../src/core/tool-executor.mjs');
  const { createToolRegistry } = await import('../src/tools/registry.mjs');
  const { parseMemoryFile, globalMemoryPath, projectMemoryPath, upsertFacts } = await import('../src/core/memory-disk.mjs');
  const { BahulamStreamClient } = await import('../src/core/stream-client.mjs');
  const noHooks = { run: async () => ({ results: [] }) };
  const makeExecutor = (options = {}) => createToolExecutor({ hookRunner: noHooks, ...options });
  const executor = makeExecutor();
  const globalFile = globalMemoryPath();
  const projectFile = projectMemoryPath();
  const facts = () => executor.getAgentContext().memory_facts;
  const snapshot = () => [globalFile, projectFile].map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

  if (reloading) {
    assert.equal(facts().find(f => f.fact_id === 'chat-init').content, longContent);
    assert.equal(facts().find(f => f.fact_id === 'preference').content, 'Updated global preference.');
    assert.equal(facts().find(f => f.fact_id === 'cached').content, 'Updated cached fact.');
    assert.equal(facts().find(f => f.fact_id === 'wire').content, 'Saved through the backend callback path.');
    process.chdir(otherProject);
    assert.ok(!facts().some(f => f.fact_id === 'chat-init'));
    assert.ok(facts().some(f => f.fact_id === 'preference'));
    console.log('Fresh-process reload passed.');
  } else {
    await test('remember is both registered and executable; unknown tools stay rejected', async () => {
      assert.ok(createToolRegistry().has('remember'));
      assert.ok(executor.listTools().includes('remember'));
      const unknown = await executor.execute('not_a_real_tool', {});
      assert.equal(unknown.success, false);
      assert.match(unknown.output, /Unknown tool/);
    });

    await test('global facts persist with metadata and become available to the next turn', async () => {
      const before = executor.getAgentContext().memory_digest;
      const result = await executor.execute('remember', {
        content: 'Global preference.', fact_id: 'preference', fact_type: 'preference', confidence: 0.95, tags: ['style'],
      });
      assert.equal(result.success, true);
      assert.equal(result._tool, 'remember');
      assert.equal(result._scope, 'global');
      assert.equal(result._fact_id, 'preference');
      assert.match(result.output, /Saved global fact/);
      assert.equal(fs.existsSync(projectFile), false);
      const saved = parseMemoryFile(globalFile)[0];
      assert.equal(saved.content, 'Global preference.');
      assert.equal(saved.fact_type, 'preference');
      assert.equal(saved.confidence, 0.95);
      assert.deepEqual(saved.tags, ['style']);
      assert.equal(saved.source, 'agent');
      assert.ok(saved.created_at && saved.updated_at);
      assert.notEqual(executor.getAgentContext().memory_digest, before);
      assert.ok(facts().some(f => f.fact_id === 'preference'));
    });

    await test('project facts retain full multiline content, not the shortened display preview', async () => {
      const result = await executor.execute('remember', { fact_id: 'chat-init', memory_scope: 'project', fact_type: 'context', content: longContent });
      assert.equal(result.success, true);
      assert.equal(result._scope, 'project');
      assert.equal(parseMemoryFile(projectFile)[0].content, longContent);
      assert.ok(!parseMemoryFile(globalFile).some(f => f.fact_id === 'chat-init'));
      assert.equal(facts().find(f => f.fact_id === 'chat-init').content, longContent);
    });

    await test('stable IDs update in place, preserving creation time and unrelated facts', async () => {
      const createdAt = '2020-01-01T00:00:00.000Z';
      const existing = parseMemoryFile(globalFile)[0];
      upsertFacts([{ ...existing, created_at: createdAt }]);
      const result = await executor.execute('remember', { fact_id: 'preference', content: 'Updated global preference.' });
      assert.equal(result.success, true);
      const matching = parseMemoryFile(globalFile).filter(f => f.fact_id === 'preference');
      assert.equal(matching.length, 1);
      assert.equal(matching[0].content, 'Updated global preference.');
      assert.equal(matching[0].created_at, createdAt);
      assert.notEqual(matching[0].updated_at, createdAt);
      assert.equal(parseMemoryFile(projectFile)[0].content, longContent);
    });

    await test('project scope shadows global IDs and does not leak to a different project', async () => {
      for (const scope of ['global', 'project']) {
        const result = await executor.execute('remember', { fact_id: 'scoped', memory_scope: scope, content: scope + ' scoped fact.' });
        assert.equal(result.success, true);
      }
      assert.equal(facts().find(f => f.fact_id === 'scoped').content, 'project scoped fact.');
      process.chdir(otherProject);
      try {
        assert.equal(facts().find(f => f.fact_id === 'scoped').content, 'global scoped fact.');
        assert.ok(!facts().some(f => f.fact_id === 'chat-init'));
      } finally { process.chdir(project); }
    });

    await test('successful writes invalidate cached memory even with unchanged filesystem mtimes', async () => {
      assert.equal((await executor.execute('remember', { fact_id: 'cached', content: 'Initial cached fact.' })).success, true);
      fs.statSync = (file, ...args) => {
        const stat = original.statSync(file, ...args);
        if ([globalFile, projectFile].includes(String(file))) stat.mtimeMs = 1;
        return stat;
      };
      syncBuiltinESMExports();
      try {
        const before = executor.getAgentContext();
        assert.equal((await executor.execute('remember', { fact_id: 'cached', content: 'Updated cached fact.' })).success, true);
        const after = executor.getAgentContext();
        assert.notEqual(after.memory_digest, before.memory_digest);
        assert.equal(after.memory_facts.find(f => f.fact_id === 'cached').content, 'Updated cached fact.');
        assert.equal(executor.getAgentContext().memory_digest, after.memory_digest);
      } finally { fs.statSync = original.statSync; syncBuiltinESMExports(); }
    });

    await test('generated IDs round-trip and invalid input returns structured failures without writes', async () => {
      const generated = await executor.execute('remember', { content: 'Generated ID fixture.', memory_scope: 'project' });
      assert.equal(generated.success, true);
      assert.ok(parseMemoryFile(projectFile).some(f => f.fact_id === generated._fact_id));
      const before = snapshot();
      for (const input of [undefined, {}, { content: '' }, { content: '  ' }, { content: 12 }, { content: 'bad confidence', confidence: 2 }]) {
        const result = await executor.execute('remember', input);
        assert.equal(result.success, false);
        assert.equal(result._tool, 'remember');
        assert.match(result.output, /^Validation error:/);
      }
      assert.deepEqual(snapshot(), before);
    });

    await test('disk write failures are reported instead of acknowledging a save', async () => {
      const before = snapshot();
      fs.writeFileSync = (file, ...args) => {
        if ([globalFile, projectFile].includes(String(file))) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
        return original.writeFileSync(file, ...args);
      };
      syncBuiltinESMExports();
      try {
        const result = await executor.execute('remember', { fact_id: 'failed', content: 'Must not save.', memory_scope: 'project' });
        assert.equal(result.success, false);
        assert.match(result.output, /remember failed:.*permission denied/);
        assert.equal(result._tool, 'remember');
      } finally { fs.writeFileSync = original.writeFileSync; syncBuiltinESMExports(); }
      assert.deepEqual(snapshot(), before);
      assert.ok(!facts().some(f => f.fact_id === 'failed'));
    });

    await test('the bridge honors hook blocking and cancellation before persistence', async () => {
      const before = snapshot();
      const blocked = makeExecutor({ hookRunner: { run: async () => ({ blocked: true, message: 'fixture policy' }) } });
      const denied = await blocked.execute('remember', { content: 'Blocked fixture.' });
      assert.equal(denied.success, false);
      assert.equal(denied._blocked, true);
      const controller = new AbortController();
      controller.abort();
      const cancelled = await executor.execute('remember', { content: 'Cancelled fixture.' }, { signal: controller.signal });
      assert.equal(cancelled.success, false);
      assert.equal(cancelled._cancelled, true);
      assert.deepEqual(snapshot(), before);
    });

    await test('backend tool requests persist locally and post truthful success/error callbacks', async () => {
      const client = new BahulamStreamClient({ baseUrl: 'https://fixture.invalid', token: 'fixture-token', toolExecutor: executor, mode: 'remote', approvalManager: {} });
      client.currentTaskId = 'fixture-task';
      const callbacks = [];
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://fixture.invalid/api/callback');
        callbacks.push(JSON.parse(options.body));
        return { ok: true, status: 200 };
      };
      try {
        const result = await client._handleToolRequest({ call_id: 'save', tool: 'remember', args: { fact_id: 'wire', memory_scope: 'project', content: 'Saved through the backend callback path.' } });
        assert.equal(result.type, 'tool_result');
        assert.equal(result.data.success, true);
        assert.equal(result.data._fact_id, 'wire');
        assert.equal(result.data.local_callback, true);
        assert.equal(callbacks[0].task_id, 'fixture-task');
        assert.equal(callbacks[0].call_id, 'save');
        assert.equal(callbacks[0].result.success, true);
        assert.match(callbacks[0].result.output, /Saved project fact 'wire'/);
        assert.equal(callbacks[0].result._tool, undefined);
        assert.ok(parseMemoryFile(projectFile).some(f => f.fact_id === 'wire'));
        const invalid = await client._handleToolRequest({ call_id: 'invalid', tool: 'remember', args: {} });
        assert.equal(invalid.data.success, false);
        assert.equal(callbacks[1].result.success, false);
        assert.match(callbacks[1].result.output, /^Validation error:/);
      } finally { globalThis.fetch = async () => { throw new Error('Unexpected network access in memory test'); }; }
    });

    await test('a fresh process reloads persisted facts with project isolation intact', async () => {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--reload', fixture], {
        cwd: project, env: process.env, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
      assert.match(child.stdout, /Fresh-process reload passed/);
    });
    console.log('\n' + passed + ' remember regressions passed.');
  }
} finally {
  process.chdir(original.cwd);
  os.homedir = original.homedir;
  fs.statSync = original.statSync;
  fs.writeFileSync = original.writeFileSync;
  globalThis.fetch = original.fetch;
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (!reloading) fs.rmSync(fixture, { recursive: true, force: true });
}
