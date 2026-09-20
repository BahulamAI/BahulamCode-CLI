import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TurnFollowups, createInstructionQueue, followupsFromTranscript } from '../src/core/followups.mjs';
import { AgentHistoryTurnBuilder } from '../src/core/agent-history.mjs';
import { LocalAgent } from '../src/core/local-agent.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log('  ✓ ' + name); }

await test('late enqueue wakes idle queue; FIFO remains single-flight', async () => {
  const first = deferred(), calls = [];
  let active = 0;
  const queue = createInstructionQueue(async text => {
    assert.equal(++active, 1); calls.push(text);
    if (text === 'first') await first.promise;
    await tick(); active--;
  });
  queue('first'); queue('second'); first.resolve();
  await tick(); await tick(); await tick();
  queue('late'); await tick(); await tick();
  assert.deepEqual(calls, ['first', 'second', 'late']);
});

await test('save precedes network; completion during save promotes without sending', async () => {
  const saved = deferred(); let sends = 0;
  const tracker = new TurnFollowups({ persist: async (_item, options) => { if (options?.initial) await saved.promise; },
    send: async () => { sends++; return { status: 'accepted' }; } });
  const submission = tracker.submit('do the tests');
  const finish = tracker.finish(); saved.resolve(); await submission;
  assert.equal(sends, 0);
  assert.equal((await finish)[0].instruction, 'do the tests');
  assert.deepEqual(await tracker.finish(), []);
});

await test('cancelling queued work can hold automatic turns without dropping manual input', async () => {
  const gate = deferred(), calls = [];
  const queue = createInstructionQueue(async item => { calls.push(item); if (item === 'running') await gate.promise; });
  queue('running'); queue({ followupId: 'next', instruction: 'queued' }); queue('manual');
  assert.equal(queue.remove(item => Boolean(item?.followupId))[0].instruction, 'queued');
  gate.resolve(); await tick(); await tick();
  assert.deepEqual(calls, ['running', 'manual']);
});

for (const status of ['accepted', 'queued_next_turn', 'duplicate', 'no_task', 'error']) {
  await test('late ' + status + ' response survives turn completion exactly once', async () => {
    const response = deferred();
    const tracker = new TurnFollowups({ persist: async () => {}, send: () => response.promise });
    const submission = tracker.submit('late instruction'); await tick();
    const finishing = tracker.finish(); response.resolve({ status }); await submission;
    const pending = await finishing;
    assert.equal(pending.length, 1); assert.equal(pending[0].instruction, 'late instruction');
    assert.deepEqual(await tracker.finish(), []);
  });
}

await test('delivery beats late acceptance and duplicate/replayed acknowledgements', async () => {
  const response = deferred(); let delivered = 0;
  const tracker = new TurnFollowups({ persist: async () => {}, send: () => response.promise, onDelivered: () => delivered++ });
  const submission = tracker.submit('apply this'); await tick();
  const id = [...tracker.items.keys()][0];
  await tracker.observe({ type: 'user_intervention_delivered', data: { intervention_id: id } });
  response.resolve({ status: 'accepted' }); await submission;
  await tracker.observe({ type: 'user_intervention_delivered', data: { intervention_id: id } });
  assert.equal(delivered, 1); assert.deepEqual(await tracker.finish(), []);
});

await test('terminal delivery snapshot reconciles a missing acknowledgement', async () => {
  const tracker = new TurnFollowups({ persist: async () => {}, send: async () => ({ status: 'accepted' }) });
  const result = await tracker.submit('already delivered');
  await tracker.observe({ type: 'complete', data: { user_interventions: { delivered_ids: [result.interventionId] } } });
  assert.deepEqual(await tracker.finish(), []);
});

await test('cancellation/disconnection holds instructions without automatic execution', async () => {
  const writes = [];
  const tracker = new TurnFollowups({ persist: async item => writes.push({ ...item }), send: async () => ({ status: 'accepted' }) });
  await tracker.submit('retain me');
  assert.deepEqual(await tracker.finish({ continueAutomatically: false }), []);
  assert.equal(writes.at(-1).status, 'held');
});

await test('multiple follow-ups retain submission order despite reversed replies', async () => {
  const replies = [deferred(), deferred()]; let n = 0;
  const tracker = new TurnFollowups({ persist: async () => {}, send: () => replies[n++].promise });
  const a = tracker.submit('first'), b = tracker.submit('second'); await tick();
  replies[1].resolve({ status: 'accepted' }); replies[0].resolve({ status: 'accepted' });
  await Promise.all([a, b]);
  assert.deepEqual((await tracker.finish()).map(item => item.instruction), ['first', 'second']);
});

await test('failed durable save never sends the instruction', async () => {
  const tracker = new TurnFollowups({ persist: async () => { throw new Error('disk failure'); }, send: () => assert.fail('not sent') });
  await assert.rejects(tracker.submit('unsaved'), /disk failure/);
  assert.deepEqual(await tracker.finish(), []);
});

await test('follow-up is a separate user message after outstanding tool results', () => {
  const builder = new AgentHistoryTurnBuilder();
  builder.addToolUse({ call_id: 'tool-1', tool: 'shell', args: { command: 'npm test' } });
  builder.addUserMessage('also check types'); // Delivery ack can precede tool_done.
  builder.addToolResult({ call_id: 'tool-1', tool: 'shell', output: 'tests passed' });
  const history = builder.finish();
  assert.equal(history[1].content[0].type, 'tool_result');
  assert.equal(history[1].content[0].content, 'tests passed');
  assert.deepEqual(history[2], { role: 'user', content: 'also check types' });
});

await test('local execution refuses late steering after its complete yield', async () => {
  const agent = new LocalAgent({ cwd: os.tmpdir(), toolExecutor: {} });
  agent.retriever.retrieve = () => [];
  agent._buildToolDefs = () => [];
  agent._buildSystemPrompt = () => 'fixture';
  agent._reduceContext = async () => null;
  agent._callLLM = async () => ({ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' });
  const stream = agent.execute('initial');
  for await (const event of stream) if (event.type === 'complete') {
    assert.equal((await agent.sendIntervention('late')).status, 'queued_next_turn');
  }
  assert.equal((await agent.sendIntervention('after')).status, 'queued_next_turn');
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-followups-'));
const previousHome = process.env.BAHULAM_HOME;
process.env.BAHULAM_HOME = fixture;
const { JsonlWriter } = await import('../src/core/jsonl-writer.mjs');
const { getSessionDetail, buildResumeHistory } = await import('../src/core/local-store.mjs');
try {
  await test('actual transcript write failure prevents network delivery', async () => {
    const writer = new JsonlWriter(fixture, 'test'); writer.setSessionId('unwritable-fixture');
    writer._transcriptPath = fixture; // Appending to a directory must fail.
    const tracker = new TurnFollowups({ persist: (item, opts) => writer.persistFollowup(item, opts),
      send: () => assert.fail('never send before successful persistence') });
    await assert.rejects(tracker.submit('keep this instruction'), /EISDIR/);
    assert.deepEqual(await tracker.finish(), []);
    await writer.close();
  });

  await test('disk round-trip restores complete text and pending work without duplicate user entries', async () => {
    const writer = new JsonlWriter(fixture, 'test'); writer.setSessionId('followup-fixture');
    writer.writeUserTurn('original');
    const instruction = 'Long instruction\n' + 'x'.repeat(12000);
    await writer.persistFollowup({ id: 'iv-pending', instruction, status: 'pending' }, { initial: true });
    await writer.persistFollowup({ id: 'iv-pending', instruction, status: 'queued' });
    await writer.close();
    let detail = await getSessionDetail('followup-fixture', { filePath: writer.transcriptPath });
    let restored = buildResumeHistory(detail, 'full');
    assert.equal(restored.pendingFollowups[0].instruction, instruction);
    assert.equal(restored.displayHistory.filter(item => item.content === instruction).length, 1);
    assert.ok(!restored.agentHistory.some(item => item.content === instruction), 'not smuggled into prior context before its own next turn');
    await writer.persistFollowup({ id: 'iv-pending', instruction, status: 'started' });
    detail = await getSessionDetail('followup-fixture', { filePath: writer.transcriptPath });
    restored = buildResumeHistory(detail, 'full');
    assert.equal(restored.pendingFollowups.length, 0);
    assert.equal(restored.interruptedFollowups.length, 1, 'uncertain started work never runs twice on resume');
    await writer.persistFollowup({ id: 'iv-pending', instruction, status: 'completed' });
    detail = await getSessionDetail('followup-fixture', { filePath: writer.transcriptPath });
    restored = buildResumeHistory(detail, 'full');
    assert.equal(restored.interruptedFollowups.length, 0);
    assert.equal(restored.agentHistory.filter(item => item.content === instruction).length, 1);
    await writer.close();
  });

  await test('legacy events become user history; ambiguous delivery requires review', () => {
    const detail = { entries: [], replayEvents: [
      { order: 1, event: { type: 'user_intervention', data: { intervention_id: 'legacy', instruction: 'previously hidden', status: 'accepted' } } },
      { order: 2, event: { type: 'user_intervention_accepted', data: { intervention_id: 'legacy', instruction: 'previously hidden' } } },
    ] };
    const restored = buildResumeHistory(detail, 'full');
    assert.deepEqual(restored.agentHistory, [{ role: 'user', content: 'previously hidden' }]);
    assert.equal(restored.pendingFollowups.length, 0);
  });

  await test('recovery distinguishes accepted, terminal-pending, delivered and future instructions', () => {
    const detail = { entries: [
      { order: 1, interventionId: 'a', role: 'user', content: 'a' },
      { order: 6, interventionId: 'b', role: 'user', content: 'b' },
    ], replayEvents: [
      { order: 2, event: { type: 'user_intervention', data: { intervention_id: 'a', status: 'accepted' } } },
      { order: 3, event: { type: 'complete', data: {} } },
      { order: 4, event: { type: 'user_intervention', data: { intervention_id: 'a', status: 'accepted' } } },
      { order: 7, event: { type: 'user_intervention', data: { intervention_id: 'b', status: 'sending' } } },
    ] };
    assert.deepEqual(followupsFromTranscript(detail).map(item => item.status), ['queued', 'sending']);
    const restored = buildResumeHistory(detail, 'full');
    assert.equal(restored.pendingFollowups[0].id, 'a');
    assert.equal(restored.interruptedFollowups[0].id, 'b');
  });
  await test('later normal turns do not restart follow-ups held after cancellation', () => {
    const restored = buildResumeHistory({ entries: [{ order: 1, interventionId: 'held', role: 'user', content: 'held' }], replayEvents: [
      { order: 2, event: { type: 'user_intervention', data: { intervention_id: 'held', status: 'held' } } },
      { order: 5, event: { type: 'complete', data: {} } },
    ] }, 'full');
    assert.equal(restored.pendingFollowups.length, 0);
    assert.equal(restored.interruptedFollowups[0].id, 'held');
  });
  await test('resumed promoted follow-up keeps its actual turn position, not its early typing position', () => {
    const restored = buildResumeHistory({ entries: [
      { order: 1, role: 'user', content: 'initial' },
      { order: 2, role: 'user', content: 'followup', interventionId: 'later' },
      { order: 4, role: 'assistant', content: 'initial reply' },
      { order: 6, role: 'assistant', content: 'followup reply' },
    ], replayEvents: [
      { order: 5, event: { type: 'user_intervention', data: { intervention_id: 'later', status: 'started' } } },
      { order: 7, event: { type: 'user_intervention', data: { intervention_id: 'later', status: 'completed' } } },
    ] }, 'full');
    assert.deepEqual(restored.agentHistory.map(item => item.content), ['initial', 'initial reply', 'followup', 'followup reply']);
  });
} finally {
  if (previousHome === undefined) delete process.env.BAHULAM_HOME; else process.env.BAHULAM_HOME = previousHome;
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log(checks + ' follow-up queue, delivery, durability and recovery regressions passed.');
