/**
 * Tests for local analytics readers and CLI report formatters.
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    })
    .catch((err) => {
      console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
      failed++;
    });
}

console.log('\n\x1b[1mtest-analytics.mjs\x1b[0m\n');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-analytics-'));
process.env.KEPLER_HOME = tempRoot;

const projectSlug = '-tmp-demo-project';
const projectsDir = path.join(tempRoot, 'projects', projectSlug);
const demoProject = path.join(tempRoot, 'demo-project');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(path.join(demoProject, 'src'), { recursive: true });
fs.writeFileSync(path.join(demoProject, 'package.json'), JSON.stringify({ name: 'demo-project' }));
fs.writeFileSync(path.join(demoProject, 'src', 'index.mjs'), 'export default 1;\n');

const sessionAPath = path.join(projectsDir, 'sess-A.jsonl');
const sessionBPath = path.join(projectsDir, 'sess-B.jsonl');
const historyPath = path.join(tempRoot, 'history.jsonl');

const sessionALines = [
  {
    type: 'user',
    timestamp: '2026-04-26T10:00:00.000Z',
    cwd: demoProject,
    sessionId: 'sess-A',
    gitBranch: 'main',
    message: { role: 'user', content: `Build the Kepler dashboard in ${demoProject}` },
  },
  {
    type: 'assistant',
    timestamp: '2026-04-26T10:00:02.000Z',
    cwd: demoProject,
    sessionId: 'sess-A',
    message: {
      role: 'assistant',
      model: 'gpt-5.4',
      usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 12 },
      content: [
        { type: 'text', text: 'Inspecting local transcripts.' },
        { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: path.join(demoProject, 'src', 'index.mjs') } },
      ],
    },
  },
  {
    type: 'user',
    timestamp: '2026-04-26T10:00:03.000Z',
    cwd: demoProject,
    sessionId: 'sess-A',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false },
      ],
    },
  },
];

const sessionBLines = [
  {
    type: 'user',
    timestamp: '2026-04-27T08:30:00.000Z',
    cwd: demoProject,
    sessionId: 'sess-B',
    gitBranch: 'feature/analytics',
    message: { role: 'user', content: 'Show usage history' },
  },
  {
    type: 'assistant',
    timestamp: '2026-04-27T08:30:05.000Z',
    cwd: demoProject,
    sessionId: 'sess-B',
    message: {
      role: 'assistant',
      model: 'gpt-5.4-mini',
      usage: { input_tokens: 40, output_tokens: 20 },
      content: 'Pulled recent history.',
    },
  },
];

fs.writeFileSync(sessionAPath, sessionALines.map((line) => JSON.stringify(line)).join('\n') + '\n');
fs.writeFileSync(sessionBPath, sessionBLines.map((line) => JSON.stringify(line)).join('\n') + '\n');
const now = Date.now();
const sessionAMtime = new Date(now - 120_000);
const sessionBMtime = new Date(now - 60_000);
fs.utimesSync(sessionAPath, sessionAMtime, sessionAMtime);
fs.utimesSync(sessionBPath, sessionBMtime, sessionBMtime);
fs.writeFileSync(historyPath, [
  JSON.stringify({ display: 'Build the Kepler dashboard', timestamp: Date.parse('2026-04-26T10:00:00.000Z'), project: demoProject, sessionId: 'sess-A' }),
  JSON.stringify({ display: 'Show usage history', timestamp: Date.parse('2026-04-27T08:30:00.000Z'), project: demoProject, sessionId: 'sess-B' }),
].join('\n') + '\n');

const localStore = await import('../src/core/local-store.mjs');
const analytics = await import('../src/terminal/analytics.mjs');

await test('getRecentSessions returns most recent transcript first', async () => {
  const sessions = await localStore.getRecentSessions(10);
  assert.strictEqual(sessions.length, 2);
  assert.strictEqual(sessions[0].sessionId, 'sess-B');
  assert.strictEqual(sessions[1].sessionId, 'sess-A');
  assert.strictEqual(sessions[1].toolCalls[0].name, 'read_file');
});

await test('getSessionDetail normalizes tool blocks', async () => {
  const detail = await localStore.getSessionDetail('sess-A');
  assert.ok(detail);
  assert.strictEqual(detail.meta.project, demoProject);
  assert.strictEqual(detail.entries.length, 3);
  assert.ok(Array.isArray(detail.entries[1].content));
  assert.strictEqual(detail.entries[1].content[1].type, 'tool_use');
  assert.strictEqual(detail.entries[1].content[1].name, 'read_file');
  assert.strictEqual(detail.entries[2].content[0].type, 'tool_result');
  assert.strictEqual(detail.entries[2].content[0].content, 'ok');
});

await test('buildResumeHistory reconstructs display history and continuity payloads', async () => {
  const detail = await localStore.getSessionDetail('sess-A');
  const compact = localStore.buildResumeHistory(detail, 'compact');
  assert.ok(compact.displayHistory.some(m => m.role === 'tool' && m.kind === 'call'));
  assert.ok(compact.displayHistory.some(m => m.role === 'tool' && m.kind === 'result'));
  assert.strictEqual(compact.agentHistory.length, 1);
  assert.ok(compact.agentHistory[0].content.includes('Session continuity summary'));
  assert.ok(compact.agentHistory[0].content.includes('read_file x1'));
  assert.deepStrictEqual(localStore.getTranscriptProjectRoots(detail), [demoProject]);

  const full = localStore.buildResumeHistory(detail, 'full');
  assert.ok(full.agentHistory.some(m => m.content.includes('[tool_call] read_file')));
  assert.ok(full.agentHistory.some(m => m.content.includes('[tool_result]')));
  assert.ok(full.agentHistory.length > compact.agentHistory.length);
});

await test('report formatters include expected analytics sections', async () => {
  const sessions = await localStore.getRecentSessions(10);
  const stats = await localStore.getSessionStats(30);
  const tools = await localStore.getToolBreakdown(30);
  const models = await localStore.getModelBreakdown(30);
  const history = localStore.getHistory(10);

  const sessionsReport = analytics.formatSessionsReport(sessions, 10);
  const statsReport = analytics.formatStatsReport(stats, tools, models, 30, localStore.getStorePaths());
  const historyReport = analytics.formatHistoryReport(history, 10);

  assert.ok(sessionsReport.includes('KEPLER SESSIONS'));
  assert.ok(sessionsReport.includes('Build the Kepler dashboard'));
  assert.ok(statsReport.includes('Top Tools'));
  assert.ok(statsReport.includes('read_file'));
  assert.ok(historyReport.includes('KEPLER HISTORY'));
  assert.ok(historyReport.includes('Show usage history'));
});

delete process.env.KEPLER_HOME;
fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
