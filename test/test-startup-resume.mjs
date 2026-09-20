import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry } from '../src/tools/project-overview.mjs';
import { ContextRetriever } from '../src/context/retriever.mjs';
import { createToolExecutor } from '../src/core/tool-executor.mjs';
import { indexDir } from '../src/core/paths.mjs';
import { fetchUserProfile, refreshStartupChecks } from '../src/terminal/startup.mjs';
import { checkAuthAndBackend, checkCreditsAndPlan } from '../src/onboarding/preflight.mjs';
import { renderResumePreview } from '../src/terminal/repl-resume.mjs';
import { formatCardHead } from '../src/ui/tool-card.mjs';
import { subAgentIndent } from '../src/ui/sub-agent.mjs';
import { strip } from '../src/ui/palette.mjs';

const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-startup-')));
process.env.BAHULAM_HOME = path.join(fixture, 'home');
process.env.BAHULAM_SKIP_AUTO_REGISTER = 'true';
const project = path.join(fixture, 'project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'package.json'), '{"name":"fixture","scripts":{"test":"node --test"}}');
fs.writeFileSync(path.join(project, 'example.js'), 'export function hello() { return "hello world"; }\n');
const registry = new ProjectRegistry();
const buildIndex = ContextRetriever.prototype.buildIndex;
let builds = 0;
ContextRetriever.prototype.buildIndex = async function () { builds++; return buildIndex.call(this); };
try {
  const start = performance.now();
  const restored = await registry.register(project, { deferIndex: true });
  assert.equal(builds, 0);
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Use the current project instructions.');
  const refreshed = await registry.register(project, { deferIndex: true });
  assert.match(refreshed.resource.project_context, /current project instructions/);
  assert.equal(builds, 0);
  assert.equal(restored.resource.index_status, 'deferred');
  assert.deepEqual(restored.resource.environment.tools, {});
  assert.ok(!fs.existsSync(path.join(indexDir(project), 'bm25.json')));
  assert.equal(await registry.resolvePath('example.js', restored.resource.project_id), path.join(project, 'example.js'));
  console.log('Local project scope restored in ' + (performance.now() - start).toFixed(1) + 'ms without index/probe work');

  const executor = createToolExecutor({ projectRegistry: registry, deferProjectIndex: true });
  const read = await executor.execute('read_file', { file_path: path.join(project, 'example.js') });
  assert.equal(read.success, true);
  const write = await executor.execute('write_file', { file_path: path.join(project, 'notes.md'), content: 'hello notes' });
  assert.equal(write.success, true);
  const noMarker = path.join(fixture, 'unrelated-folder');
  fs.mkdirSync(noMarker);
  const denied = await executor.registerProjectRoots([noMarker], { deferIndex: true, bypassProjectMarkers: false });
  assert.equal(denied[0].success, false, 'inferred resume roots still require project markers');
  assert.equal(builds, 0, 'ordinary file tools do not eagerly initialize search');
  assert.equal(restored.resource.index_status, 'deferred');

  // The first real search upgrades the deferred scope; simultaneous overview
  // registration shares that same index operation.
  const [search, overview] = await Promise.all([
    executor.execute('search_code', { project_id: restored.resource.project_id, query: 'hello' }),
    registry.register(project),
  ]);
  assert.equal(search.success, true);
  assert.match(search.output, /hello/);
  assert.equal(overview.resource.index_status, 'ready');
  assert.equal(builds, 1, 'one build for simultaneous requests');
  await registry.register(project);
  assert.equal(builds, 1, 'unchanged index reused');
  assert.ok(registry._environment, 'tool versions cached once per registry');

  await assert.rejects(registry.register('/', { deferIndex: true, bypassProjectMarkers: true }), /Refusing/);
  await assert.rejects(registry.resolvePath('/unregistered/secret', undefined), /registered|outside|project/i);
} finally { ContextRetriever.prototype.buildIndex = buildIndex; }

const creds = { backendUrl: 'https://unused.example', token: 'test-token' };
const auth = { loadCredentials: () => ({ ...creds }) };
for (const slowBody of [false, true]) {
  let aborted = false;
  const result = await fetchUserProfile(auth, {
    timeoutMs: 15,
    fetchImpl: async (_url, { signal }) => {
      const slow = () => new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        aborted = true; reject(new Error('aborted'));
      }, { once: true }));
      return slowBody ? { ok: true, json: slow } : slow();
    },
  });
  assert.equal(result, null);
  assert.equal(aborted, true, 'deadline covers both headers and body');
}
const realFetch = globalThis.fetch;
try {
  for (const check of [checkAuthAndBackend, checkCreditsAndPlan]) {
    let aborted = false;
    globalThis.fetch = async (_url, { signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }) });
    await check(auth, { timeoutMs: 15 });
    assert.equal(aborted, true, 'preflight deadline includes JSON body');
  }
} finally { globalThis.fetch = realFetch; }

const state = { model: 'chosen-model', modelOverrides: {} };
await refreshStartupChecks({ auth, session: state, runChecks: async () => [{ status: 'ok', user: { default_reasoning_model: 'profile-model' } }] });
assert.equal(state.model, 'chosen-model');
assert.ok(state.user);
const fresh = {};
await refreshStartupChecks({ auth, session: fresh, preflight: false, fetchProfile: async () => ({ default_reasoning_model: 'profile-model' }) });
assert.equal(fresh.model, 'profile-model');
let release;
const lateState = {};
const late = refreshStartupChecks({ auth, session: lateState, runChecks: () => new Promise(resolve => { release = resolve; }) });
creds.token = 'changed-token';
release([{ user: { default_reasoning_model: 'stale' } }]);
await late;
assert.equal(lateState.user, undefined, 'late response cannot undo changed credentials');

let output = '';
const stderr = process.stderr.write;
const history = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'message_' + i }));
try {
  process.stderr.write = chunk => { output += String(chunk); return true; };
  renderResumePreview({ history, historyMode: 'full', replayEvents: [{}] }, { previewOnly: true, renderEvent: () => assert.fail('must not replay live tools at startup') });
} finally { process.stderr.write = stderr; }
assert.equal(history.length, 100);
assert.ok(output.includes('message_99') && !output.includes('message_90'));
assert.match(output, /6 of 100/);
for (const tool of ['edit_file', 'shell']) {
  const head = strip(formatCardHead(tool, { command: 'npm test', file_path: 'example.js' }, { indent: subAgentIndent() }));
  assert.equal(head.match(/^ */)[0].length, 2, 'all live tool headers share a baseline');
  if (tool === 'shell') assert.match(head, /\n {4}\$ npm test/);
}

const startupProject = path.join(fixture, 'startup-project');
fs.mkdirSync(startupProject);
fs.writeFileSync(path.join(startupProject, 'package.json'), '{}');
const transcriptDir = path.join(process.env.BAHULAM_HOME, 'projects', startupProject.replaceAll('/', '-'));
fs.mkdirSync(transcriptDir, { recursive: true });
const transcript = path.join(transcriptDir, 'startup-fixture.jsonl');
const records = Array.from({ length: 100 }, (_, i) => ({
  type: i % 2 ? 'assistant' : 'user', cwd: startupProject, timestamp: new Date().toISOString(),
  message: { role: i % 2 ? 'assistant' : 'user', content: 'Fixture message ' + i },
}));
fs.writeFileSync(transcript, records.map(record => JSON.stringify(record)).join('\n') + '\n');
const started = performance.now();
const child = spawnSync(process.execPath, [fileURLToPath(new URL('../src/terminal/main.mjs', import.meta.url)), '--resume', 'startup-fixture'], {
  cwd: startupProject, input: '/exit\n', encoding: 'utf8', timeout: 10000,
  env: { ...process.env, BAHULAM_NO_PREFLIGHT: '1', BAHULAM_SKIP_UPGRADE_CHECK: 'true',
    BAHULAM_SKIP_AUTO_REGISTER: 'false', BAHULAM_AUTO_ATTACH: '0', BAHULAM_PLAIN: '1' },
});
const startupOutput = (child.stdout || '') + (child.stderr || '');
assert.equal(child.status, 0, child.error?.message || startupOutput);
assert.ok(startupOutput.includes('Resumed session: 100 messages'));
assert.ok(startupOutput.includes('Local session ready'));
assert.ok(startupOutput.includes('Fixture message 99'));
assert.ok(!startupOutput.includes('Fixture message 10'));
assert.ok(!fs.existsSync(path.join(indexDir(startupProject), 'bm25.json')));
const saved = fs.readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
assert.equal(saved.filter(row => row.message).length, 100, 'resume does not rewrite or drop original history');
console.log('End-to-end offline resume: ' + Math.round(performance.now() - started) + 'ms; 100 original messages preserved, no index built.');

console.log('Startup/resume regressions passed: lazy indexing, deduplication, safe scope, deadlines, profile races, bounded replay and indentation.');
