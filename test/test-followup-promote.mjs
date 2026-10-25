/**
 * Tests for the follow-up promote + background-job nudge machinery in
 * LocalAgentRelay. These tests instantiate the class with the minimum
 * scaffolding needed and stub out the heavyweight runTurn body so we
 * exercise the routing decisions in isolation.
 */

import assert from 'node:assert';
import { LocalAgentRelay } from '../src/local-service/agent-relay.mjs';
import { AssistantMessageStream } from '../src/local-service/chat-presentation.mjs';

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

await test('terminal completion queues accepted follow-ups without delivery acknowledgement', async () => {
  const { relay, events } = makeRelay();
  relay.running = true;
  relay.currentTurnId = 'turn-1';
  relay.client = { currentTaskId: 'task-1', sendIntervention: async (_text, options) =>
    ({ status: 'accepted', interventionId: options.idempotencyKey }) };
  relay._ensureJsonlWriter = () => ({ writeBahulamEvent() {} });
  const result = await relay.sendFollowup({ instruction: 'continue after final', clientId: 'client-1' });
  relay._emitAgentEvent({ type: 'complete', data: { user_interventions: { delivered_ids: [] } } }, { turnId: 'turn-1' });
  relay._queueUndeliveredFollowups('turn-1');
  assert.equal(result.status, 'accepted');
  assert.equal(relay.displayHistory.filter(entry => entry.content === 'continue after final').length, 1);
  assert.ok(events.some(event => event.type === 'agent_followup_status'
    && event.data.status === 'queued_next_turn' && event.data.client_id === 'client-1'));
});

await test('late acceptance cannot undo next-turn queue after completion', async () => {
  const { relay } = makeRelay();
  relay.running = true;
  relay.currentTurnId = 'turn-1';
  let accept;
  relay.client = { currentTaskId: 'task-1', sendIntervention: () => new Promise(resolve => { accept = resolve; }) };
  relay._ensureJsonlWriter = () => ({ writeBahulamEvent() {} });
  const pending = relay.sendFollowup({ instruction: 'late follow-up', clientId: 'client-2' });
  relay._emitAgentEvent({ type: 'complete', data: {} }, { turnId: 'turn-1' });
  relay._queueUndeliveredFollowups('turn-1');
  accept({ status: 'accepted' });
  assert.equal((await pending).status, 'queued_next_turn');
});

await test('running a queued follow-up reuses its user entry and transcript record', async () => {
  const { relay } = makeRelay();
  const writes = [];
  relay.resumeLoaded = true;
  relay.creds = { backendUrl: 'http://example.test' };
  relay.client = { sessionId: 'session-1', currentTaskId: null,
    async *execute() { yield { type: 'complete', data: {} }; } };
  relay._ensureReady = async () => {};
  relay._buildInstruction = instruction => instruction;
  relay._buildExecContext = async () => ({});
  relay._ensureJsonlWriter = () => ({ sessionId: 'session-1',
    writeUserTurn: () => writes.push('user'), writeHistory() {},
    writeBahulamEvent: event => writes.push(event.data?.status || event.type),
    setTurnUsage() {}, flushAssistantTurn() {}, async flush() {} });
  const entry = { role: 'user', content: 'late follow-up', clientId: 'client-3',
    interventionId: 'iv-3', followupStatus: 'queued_next_turn', turnId: 'earlier' };
  relay.displayHistory.push(entry);
  relay.followupEntries.set('iv-3', entry);
  await relay.runTurn({ prompt: 'late follow-up', followupClientId: 'client-3' });
  assert.deepEqual(writes.filter(value => ['user', 'started', 'completed'].includes(value)), ['started', 'completed']);
  assert.equal(relay.displayHistory.filter(item => item.role === 'user').length, 1);
  assert.equal(entry.followupStatus, 'completed');
});

await test('assistant presentation retains an additive content event after partial text', () => {
  const stream = new AssistantMessageStream();
  const first = stream.accept({ type: 'content_partial', data: { text: 'Alpha ' } }, 'turn-1');
  const final = stream.accept({ type: 'content', data: { text: 'Beta' } }, 'turn-1');
  assert.equal(first.text + final.text, 'Alpha Beta');
  assert.equal(final.content, 'Alpha Beta');
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
