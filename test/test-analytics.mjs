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
    type: 'kepler_event',
    timestamp: '2026-04-26T10:00:02.500Z',
    cwd: demoProject,
    sessionId: 'sess-A',
    event: { type: 'tool_call', data: { tool: 'read_file', args: { path: path.join(demoProject, 'src', 'index.mjs') } } },
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
  {
    type: 'kepler_event',
    timestamp: '2026-04-27T08:30:06.000Z',
    cwd: demoProject,
    sessionId: 'sess-B',
    event: {
      type: 'resume_summary',
      data: {
        summary: 'Prior summary for sess-B.',
        source_message_count: 2,
        previous_source_message_count: 0,
        full_message_count: 2,
        summary_source: 'backend',
        mode: 'summary',
        mode_label: 'summary only',
      },
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
  assert.strictEqual(sessions[0].resumeSummary.sourceMessageCount, 2);
  assert.strictEqual(sessions[0].resumeSummary.summarySource, 'backend');
});

await test('getSessionDetail normalizes tool blocks', async () => {
  const detail = await localStore.getSessionDetail('sess-A');
  assert.ok(detail);
  assert.strictEqual(detail.meta.project, demoProject);
  assert.strictEqual(detail.entries.length, 3);
  assert.strictEqual(detail.replayEvents.length, 1);
  assert.strictEqual(detail.replayEvents[0].event.type, 'tool_call');
  assert.deepStrictEqual(detail.entries.map(e => e.order), [0, 1, 3]);
  assert.strictEqual(detail.replayEvents[0].order, 2);
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
  assert.strictEqual(compact.displayHistory.find(m => m.role === 'user')?.order, 0);
  assert.strictEqual(compact.agentHistory.length, 3);
  assert.strictEqual(compact.summaryMessageIndex, 2);
  assert.ok(compact.agentHistory[0].content.includes('Resume metadata'));
  assert.ok(compact.agentHistory[1].content.includes('Original user request'));
  assert.ok(compact.agentHistory[2].content.includes('Session continuity summary'));
  assert.ok(compact.agentHistory[2].content.includes('read_file x1'));
  assert.deepStrictEqual(localStore.getTranscriptProjectRoots(detail), [demoProject]);

  const full = localStore.buildResumeHistory(detail, 'full');
  assert.ok(full.agentHistory.some(m => m.content.includes('[tool_call] read_file')));
  assert.ok(full.agentHistory.some(m => m.content.includes('[tool_result]')));
  assert.strictEqual(full.sourceMessages.length, full.agentHistory.length);
});

await test('buildResumeHistory tail modes summarize older messages and keep the last N conversation messages', async () => {
  const detail = {
    entries: [
      { role: 'user', content: 'turn 1: old request', timestamp: '2026-04-26T10:00:00.000Z', order: 0 },
      { role: 'assistant', content: 'answer 1', timestamp: '2026-04-26T10:00:01.000Z', order: 1 },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-old', content: 'old tool result' }],
        timestamp: '2026-04-26T10:00:02.000Z',
        order: 2,
      },
      { role: 'user', content: 'turn 2: recent request', timestamp: '2026-04-26T10:00:03.000Z', order: 3 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer 2' },
          { type: 'tool_use', id: 'tool-new', name: 'read_file', input: { path: 'README.md' } },
        ],
        timestamp: '2026-04-26T10:00:04.000Z',
        order: 4,
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-new', content: 'recent tool result' }],
        timestamp: '2026-04-26T10:00:05.000Z',
        order: 5,
      },
      { role: 'user', content: 'turn 3: latest request', timestamp: '2026-04-26T10:00:06.000Z', order: 6 },
      { role: 'assistant', content: 'answer 3', timestamp: '2026-04-26T10:00:07.000Z', order: 7 },
    ],
  };

  const tail = localStore.buildResumeHistory(detail, 'tail-4');
  const metadata = tail.agentHistory[0]?.content || '';
  const original = tail.agentHistory[1]?.content || '';
  const summary = tail.agentHistory[tail.summaryMessageIndex]?.content || '';
  const payload = tail.agentHistory.slice(tail.summaryMessageIndex + 1).map(m => m.content).join('\n');
  const summarySource = tail.sourceMessages.map(m => m.content).join('\n');

  assert.ok(metadata.includes('Resume metadata'));
  assert.ok(original.includes('turn 1: old request'));
  assert.ok(summary.includes('Summary of earlier turns before the last 4 conversation messages'));
  assert.ok(payload.includes('answer 2'));
  assert.ok(payload.includes('recent tool result'));
  assert.ok(payload.includes('turn 3: latest request'));
  assert.ok(!payload.includes('turn 2: recent request'));
  assert.ok(!payload.includes('turn 1: old request'));
  assert.ok(!payload.includes('old tool result'));
  assert.ok(summarySource.includes('turn 1: old request'));
  assert.ok(summarySource.includes('old tool result'));
  assert.ok(summarySource.includes('turn 2: recent request'));
  assert.ok(!summarySource.includes('recent tool result'));
});

await test('buildResumeHistory resumes summarization from the latest summary checkpoint', async () => {
  const detail = {
    sessionId: 'sess-checkpoint',
    meta: { project: demoProject, firstPrompt: 'turn 1: old request' },
    replayEvents: [
      {
        order: 10,
        timestamp: '2026-04-26T10:00:02.500Z',
        event: {
          type: 'resume_summary',
          data: {
            summary: 'Previously summarized checkpoint: turn 1 and old tool result.',
            source_message_count: 3,
          },
        },
      },
    ],
    entries: [
      { role: 'user', content: 'turn 1: old request', timestamp: '2026-04-26T10:00:00.000Z', order: 0 },
      { role: 'assistant', content: 'answer 1', timestamp: '2026-04-26T10:00:01.000Z', order: 1 },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-old', content: 'old tool result' }],
        timestamp: '2026-04-26T10:00:02.000Z',
        order: 2,
      },
      { role: 'user', content: 'turn 2: middle request', timestamp: '2026-04-26T10:00:03.000Z', order: 3 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer 2' },
          { type: 'tool_use', id: 'tool-new', name: 'read_file', input: { path: 'README.md' } },
        ],
        timestamp: '2026-04-26T10:00:04.000Z',
        order: 4,
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-new', content: 'recent tool result' }],
        timestamp: '2026-04-26T10:00:05.000Z',
        order: 5,
      },
      { role: 'user', content: 'turn 3: latest request', timestamp: '2026-04-26T10:00:06.000Z', order: 6 },
      { role: 'assistant', content: 'answer 3', timestamp: '2026-04-26T10:00:07.000Z', order: 7 },
    ],
  };

  const tail = localStore.buildResumeHistory(detail, 'tail-4');
  const summary = tail.agentHistory[tail.summaryMessageIndex]?.content || '';
  const summarySource = tail.sourceMessages.map(m => m.content).join('\n');

  assert.strictEqual(tail.summaryCheckpointMessageCount, 3);
  assert.strictEqual(tail.summaryCoveredMessageCount, 4);
  assert.ok(summary.includes('Previously summarized checkpoint'));
  assert.ok(summary.includes('New activity since previous summary'));
  assert.ok(summary.includes('turn 2: middle request'));
  assert.ok(!summarySource.includes('turn 1: old request'));
  assert.ok(!summarySource.includes('old tool result'));
  assert.ok(summarySource.includes('turn 2: middle request'));

  const compact = localStore.buildResumeHistory(detail, 'summary');
  assert.strictEqual(compact.summaryCheckpointMessageCount, 3);
  assert.strictEqual(compact.summaryCoveredMessageCount, 8);
  assert.ok(compact.sourceMessages.map(m => m.content).join('\n').includes('answer 3'));
  assert.ok(!compact.sourceMessages.map(m => m.content).join('\n').includes('turn 1: old request'));
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
