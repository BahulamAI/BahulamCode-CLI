/**
 * Tests for the follow-up promote + background-job nudge machinery in
 * LocalAgentRelay. These tests instantiate the class with the minimum
 * scaffolding needed and stub out the heavyweight runTurn body so we
 * exercise the routing decisions in isolation.
 */

import assert from 'node:assert';
import { LocalAgentRelay } from '../src/local-service/agent-relay.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  }
}

function makeRelay({ root_path = '/Users/test/proj' } = {}) {
  const events = [];
  const emit = (type, data) => { events.push({ type, data }); };
  const session = { id: 'test-session', root_path };
  const relay = new LocalAgentRelay({ session, emit });
  return { relay, events };
}

// Track calls to runTurn without actually executing the heavy path.
function stubRunTurn(relay) {
  const calls = [];
  relay.runTurn = async (args) => {
    calls.push(args);
    return { ok: true, turn_id: 'stub-turn' };
  };
  return calls;
}

console.log('\n\x1b[1mtest-followup-promote.mjs\x1b[0m\n');

// ── Follow-up promote ──────────────────────────────────────────────────

await test('sendFollowup when idle promotes to a new turn', async () => {
  const { relay, events } = makeRelay();
  const runTurnCalls = stubRunTurn(relay);

  const res = await relay.sendFollowup({ instruction: 'continue' });
  assert.strictEqual(res.status, 'promoted_to_new_turn');
  assert.ok(res.intervention_id, 'intervention_id should be present');
  // give the fire-and-forget runTurn a tick to be invoked (it's not awaited)
  await new Promise(r => setImmediate(r));
  assert.strictEqual(runTurnCalls.length, 1);
  assert.strictEqual(runTurnCalls[0].prompt, 'continue');
  assert.ok(events.find(e => e.type === 'agent_followup_promoted'), 'should emit agent_followup_promoted');
});

await test('sendFollowup when running goes through the existing follow-up queue path', async () => {
  const { relay } = makeRelay();
  const runTurnCalls = stubRunTurn(relay);
  // Simulate a running turn with a currentTaskId so it queues normally.
  relay.running = true;
  relay.client = { currentTaskId: null };  // no task id yet → queues to pendingFollowups
  const res = await relay.sendFollowup({ instruction: 'more please' });
  assert.strictEqual(res.status, 'waiting_for_task');
  assert.strictEqual(relay.pendingFollowups.length, 1, 'should queue when running');
  assert.strictEqual(runTurnCalls.length, 0, 'should not promote when running');
});

await test('sendFollowup rejects empty instruction', async () => {
  const { relay } = makeRelay();
  stubRunTurn(relay);
  await assert.rejects(relay.sendFollowup({ instruction: '' }), /instruction is required/);
});

// ── Background-job nudge ───────────────────────────────────────────────

function jobDesc(overrides = {}) {
  return {
    id: 'job-1-abc',
    name: 'test',
    command: 'sleep 2 && echo done',
    cwd: '/Users/test/proj',
    pid: 12345,
    status: 'completed',
    exit_code: 0,
    duration_s: 2,
    log_path: '/tmp/x.log',
    tail: 'done\n',
    on_complete: null,
    ...overrides,
  };
}

await test('_onBackgroundJobFinished promotes a new turn when idle', async () => {
  const { relay, events } = makeRelay();
  const runTurnCalls = stubRunTurn(relay);
  relay._onBackgroundJobFinished(jobDesc());
  await new Promise(r => setImmediate(r));
  assert.strictEqual(runTurnCalls.length, 1);
  assert.match(runTurnCalls[0].prompt, /Background job `job-1-abc` finished/);
  assert.match(runTurnCalls[0].prompt, /status=completed/);
  const evt = events.find(e => e.type === 'agent_background_job_finished');
  assert.ok(evt, 'should emit agent_background_job_finished');
  assert.strictEqual(evt.data.job_id, 'job-1-abc');
});

await test('_onBackgroundJobFinished queues a follow-up when running', async () => {
  const { relay } = makeRelay();
  const runTurnCalls = stubRunTurn(relay);
  relay.running = true;
  relay.client = { currentTaskId: null };
  relay._onBackgroundJobFinished(jobDesc());
  assert.strictEqual(runTurnCalls.length, 0, 'no runTurn when running');
  assert.strictEqual(relay.pendingFollowups.length, 1);
  assert.strictEqual(relay.pendingFollowups[0].messageType, 'background_job_nudge');
});

await test('_onBackgroundJobFinished is idempotent per job id', async () => {
  const { relay } = makeRelay();
  const runTurnCalls = stubRunTurn(relay);
  relay._onBackgroundJobFinished(jobDesc());
  relay._onBackgroundJobFinished(jobDesc());
  await new Promise(r => setImmediate(r));
  assert.strictEqual(runTurnCalls.length, 1, 'second call must be ignored');
});

await test('_onBackgroundJobFinished skips jobs with an explicit on_complete', async () => {
  const { relay } = makeRelay();
  const runTurnCalls = stubRunTurn(relay);
  relay._onBackgroundJobFinished(jobDesc({ on_complete: { target: 'agent:renderer' } }));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(runTurnCalls.length, 0);
});

await test('_onBackgroundJobFinished skips killed jobs', async () => {
  const { relay } = makeRelay();
  const runTurnCalls = stubRunTurn(relay);
  relay._onBackgroundJobFinished(jobDesc({ status: 'killed', exit_code: null }));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(runTurnCalls.length, 0);
});

await test('_onBackgroundJobFinished skips jobs outside the workspace cwd', async () => {
  const { relay } = makeRelay({ root_path: '/Users/test/proj' });
  const runTurnCalls = stubRunTurn(relay);
  relay._onBackgroundJobFinished(jobDesc({ cwd: '/somewhere/else' }));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(runTurnCalls.length, 0);
});

await test('_onBackgroundJobFinished still nudges when workspace root is not set', async () => {
  const { relay } = makeRelay({ root_path: '' });
  const runTurnCalls = stubRunTurn(relay);
  relay._onBackgroundJobFinished(jobDesc({ cwd: '/anywhere' }));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(runTurnCalls.length, 1);
});

await test('_buildBackgroundJobNudge produces expected structure', async () => {
  const { relay } = makeRelay();
  const nudge = relay._buildBackgroundJobNudge(jobDesc({
    tail: 'line1\nline2\nline3\n',
  }));
  assert.match(nudge, /Background job `job-1-abc` finished/);
  assert.match(nudge, /Command: sleep 2/);
  assert.match(nudge, /line3/);
  assert.match(nudge, /Continue from here\./);
});

await test('_buildBackgroundJobNudge handles empty tail', async () => {
  const { relay } = makeRelay();
  const nudge = relay._buildBackgroundJobNudge(jobDesc({ tail: '' }));
  assert.match(nudge, /\(no output captured\)/);
});

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n  \x1b[32m${passed} passed\x1b[0m${failed ? `, \x1b[31m${failed} failed\x1b[0m` : ''}\n`);
if (failed) process.exit(1);
