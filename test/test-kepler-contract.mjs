import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scaffoldKeplerProject } from '../src/terminal/init.mjs';
import { loadEffectivePolicy } from '../src/core/policy-resolver.mjs';
import { contextToPromptBlock, loadProjectContext } from '../src/core/project-context-loader.mjs';
import { buildContextEnvelope } from '../src/core/context-envelope.mjs';
import { appendTask, ensureTaskFiles, loadTaskBoard, moveTask, parseTaskMarkdown, removeTask, taskCounts, updateTask } from '../src/core/tasks.mjs';
import { applyCompactSummary, localCompactSummary, parseCompactTailCount, prepareCompactHistory } from '../src/core/compact-history.mjs';
import { HookRunner } from '../src/config/hook-runner.mjs';
import { ApprovalManager } from '../src/core/approval.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.stack || err.message}`);
    failed++;
  }
}

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-contract-'));
}

console.log('\n\x1b[1mtest-kepler-contract.mjs\x1b[0m\n');

await test('kepler init scaffolds project contract', async () => {
  const cwd = tempProject();
  const result = scaffoldKeplerProject({ cwd });
  assert.ok(fs.existsSync(path.join(cwd, '.bahulam', 'README.md')));
  assert.ok(fs.existsSync(path.join(cwd, '.bahulam', 'config.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.bahulam', 'settings.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.bahulam', 'KEPLER.md')));
  assert.ok(fs.existsSync(path.join(cwd, '.bahulam', 'tasks', 'backlog.md')));
  assert.ok(result.written.length > 8);
});

await test('policy resolver merges project config and tracks source', async () => {
  const cwd = tempProject();
  scaffoldKeplerProject({ cwd });
  fs.writeFileSync(path.join(cwd, '.bahulam', 'config.json'), JSON.stringify({
    version: 1,
    planning: { owner: 'manual' },
    hitl: { reaskAfterMinutes: 7 },
  }));
  const effective = loadEffectivePolicy({ cwd });
  assert.strictEqual(effective.policy.planning.owner, 'manual');
  assert.strictEqual(effective.policy.hitl.reaskAfterMinutes, 7);
  assert.strictEqual(effective.sources['planning.owner'].source, 'project');
});

await test('project context loader reads hand-editable files and detects changes', async () => {
  const cwd = tempProject();
  scaffoldKeplerProject({ cwd });
  fs.writeFileSync(path.join(cwd, '.bahulam', 'plan.md'), '1. Old plan\n');
  const first = loadProjectContext({ cwd });
  fs.writeFileSync(path.join(cwd, '.bahulam', 'plan.md'), '1. New plan\n');
  const second = loadProjectContext({ cwd, previous: first });
  assert.ok(second.loaded.some(f => f.label === 'plan.md'));
  assert.ok(second.changed.some(f => f.label === 'plan.md'));
});

await test('context envelope packages policy, files, skills, and timeouts', async () => {
  const cwd = tempProject();
  scaffoldKeplerProject({ cwd });
  const policy = loadEffectivePolicy({ cwd });
  const context = loadProjectContext({ cwd });
  const envelope = buildContextEnvelope({
    cwd,
    command: 'heal',
    args: ['auth.test.ts'],
    effectivePolicy: policy,
    projectContext: context,
  });
  assert.strictEqual(envelope.command_context.active_command, 'heal');
  assert.strictEqual(envelope.command_context.runtime_limits.command_timeout_seconds, 600);
  assert.ok(envelope.project_context.loaded_files.some(f => f.label === 'KEPLER.md'));
  assert.ok(envelope.available_skills.some(s => s.name === 'starter'));
});

await test('task board reads and appends project task markdown', async () => {
  const cwd = tempProject();
  ensureTaskFiles({ cwd });
  appendTask({ cwd, list: 'active', text: 'Wire /plan status' });
  appendTask({ cwd, list: 'blocked', text: 'Waiting on backend deploy' });
  appendTask({ cwd, list: 'done', text: 'Ship HITL prompt polish' });

  const board = loadTaskBoard({ cwd });
  const counts = taskCounts(board);
  assert.strictEqual(counts.active, 1);
  assert.strictEqual(counts.blocked, 1);
  assert.strictEqual(counts.done, 1);
  assert.ok(board.lists.active.tasks[0].text.includes('/plan status'));
});

await test('task board edits, moves, and removes project task markdown', async () => {
  const cwd = tempProject();
  ensureTaskFiles({ cwd });
  appendTask({ cwd, list: 'active', text: 'Draft task UX' });
  appendTask({ cwd, list: 'active', text: 'Ship task UX' });

  const edited = updateTask({ cwd, list: 'active', index: 1, text: 'Draft task move UX' });
  assert.strictEqual(edited.text, 'Draft task move UX');

  const moved = moveTask({ cwd, from: 'active', index: 1, to: 'done' });
  assert.strictEqual(moved.text, 'Draft task move UX');
  assert.strictEqual(moved.to, 'done');

  const removed = removeTask({ cwd, list: 'active', index: 1 });
  assert.strictEqual(removed.task.text, 'Ship task UX');

  const board = loadTaskBoard({ cwd });
  const counts = taskCounts(board);
  assert.strictEqual(counts.active, 0);
  assert.strictEqual(counts.done, 1);
  assert.strictEqual(board.lists.done.tasks[0].checked, true);
});

await test('task parser supports checkboxes and plain bullets', async () => {
  const tasks = parseTaskMarkdown('# Active\n\n- [ ] First\n- [x] Done-ish\n- Plain bullet\n', 'active');
  assert.strictEqual(tasks.length, 3);
  assert.strictEqual(tasks[0].checked, false);
  assert.strictEqual(tasks[1].checked, true);
  assert.strictEqual(tasks[2].text, 'Plain bullet');
});

await test('project context injects task workflow guidance', async () => {
  const cwd = tempProject();
  scaffoldKeplerProject({ cwd });
  appendTask({ cwd, list: 'active', text: 'Keep tasks current' });
  const context = loadProjectContext({ cwd });
  const prompt = contextToPromptBlock(context);
  assert.ok(prompt.includes('Keep .bahulam/tasks/active.md current'));
  assert.ok(prompt.includes('Keep tasks current'));
});

await test('/compact helper summarizes prefix and preserves recent tail', async () => {
  const history = [
    { role: 'user', content: 'first task' },
    { role: 'assistant', content: 'first response' },
    { role: 'user', content: 'second task' },
    { role: 'assistant', content: 'second response' },
    { role: 'user', content: 'third task' },
    { role: 'assistant', content: 'third response' },
  ];
  const prepared = prepareCompactHistory({ agentHistory: history, tailCount: 2 });
  assert.strictEqual(prepared.ok, true);
  assert.strictEqual(prepared.sourceMessages.length, 4);
  assert.strictEqual(prepared.tail.length, 2);

  const localSummary = localCompactSummary(prepared.sourceMessages);
  assert.ok(localSummary.includes('first task'));

  const applied = applyCompactSummary({
    prepared,
    summary: 'Summary anchor',
    sessionId: 'session-1',
    cwd: '/tmp/project',
    previousSourceMessageCount: 3,
    now: new Date('2026-07-13T00:00:00.000Z'),
  });
  assert.strictEqual(applied.agentHistory.length, 5);
  assert.strictEqual(applied.sourceMessageCount, 7);
  assert.ok(applied.agentHistory[2].content.includes('Session continuity summary after /compact'));
  assert.deepStrictEqual(applied.agentHistory.slice(-2), prepared.tail);
  assert.strictEqual(parseCompactTailCount('--tail=12'), 12);
  assert.strictEqual(parseCompactTailCount('20'), 20);
});

await test('hook runner blocks tools and captures feedback', async () => {
  const cwd = tempProject();
  scaffoldKeplerProject({ cwd });
  fs.writeFileSync(path.join(cwd, '.bahulam', 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'shell', command: 'printf \'{"block":true,"message":"no shell"}\'; exit 2', timeout: 1 }],
      UserPromptSubmit: [{ command: 'printf \'{"feedback":"load testing skill"}\'', timeout: 1 }],
    },
  }));
  const runner = new HookRunner({ cwd });
  const pre = await runner.run('PreToolUse', { toolName: 'shell', input: { command: 'npm test' } });
  assert.strictEqual(pre.blocked, true);
  assert.ok(pre.message.includes('no shell'));
  const prompt = await runner.run('UserPromptSubmit', { input: { prompt: 'run tests' } });
  assert.strictEqual(prompt.results[0].parsed.feedback, 'load testing skill');
});

await test('approval manager honors saved session trust and approval log', async () => {
  const cwd = tempProject();
  scaffoldKeplerProject({ cwd });
  const policy = loadEffectivePolicy({ cwd, cli: { hitl: { alwaysAskForDangerous: false } } }).policy;
  const mgr = new ApprovalManager({ cwd, policy });
  mgr.trustStore.add({
    tool: 'shell',
    args: { command: 'rm -rf build' },
    tier: 'shell-dangerous',
    scope: 'SESSION',
  });
  mgr._readKey = async () => 'n';
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const first = await mgr.check('shell', { command: 'rm -rf build' });
    assert.strictEqual(first.approved, true);
    assert.strictEqual(first.scope, 'SESSION');
    const second = await mgr.check('shell', { command: 'rm -rf dist' });
    assert.strictEqual(second.approved, true);
    assert.strictEqual(second.scope, 'SESSION');
  } finally {
    process.stderr.write = originalWrite;
  }
  const log = fs.readFileSync(path.join(cwd, '.bahulam', 'approvals.log'), 'utf-8');
  assert.ok(log.includes('auto_trusted'));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
