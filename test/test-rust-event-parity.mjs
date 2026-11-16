import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentLoop } from '../src/core/loop.mjs';
import { tapSseEvent, registerBroadcaster } from '../src/daemon/event-tap.mjs';

process.env.BAHULAM_DAEMON_EVENTLOG = '0';
function capture(sessionId, events) {
  const frames = [];
  const unsubscribe = registerBroadcaster(frame => frames.push(frame), { schemaVersion: 2, live: true });
  const before = JSON.stringify(events);
  try { for (const event of events) tapSseEvent(event, { sessionId }); }
  finally { unsubscribe(); }
  assert.equal(JSON.stringify(events), before, 'projection must not mutate producer events');
  return frames;
}
const e = (type, data = {}) => ({ type, data });

test('real gateway completions preserve IDs, full results, failures, and model tool responses', async () => {
  const messages = [{ role: 'user', content: 'fixture' }];
  let calls = 0;
  const events = [];
  for await (const event of createAgentLoop({ session: {}, messages,
    gatewayFetch: async () => ({ message: calls++ ? { content: 'finished' } : {
      tool_calls: ['success', 'failure', 'throws'].map(id => ({ id, function: { name: 'shell', arguments: JSON.stringify({ command: id }) } })),
    } }),
    toolExecutor: { execute: async (_, { command }) => {
      if (command === 'throws') throw new Error('fixture failure');
      return { success: command === 'success', output: `${command} full result`, exit_code: command === 'success' ? 0 : 3 };
    } },
  })) events.push(event);
  const completions = events.filter(event => event.type === 'tool_done');
  assert.deepEqual(completions.map(event => event.data.call_id), ['success', 'failure', 'throws']);
  assert.deepEqual(completions.map(event => event.data.success), [true, false, false]);
  assert.ok(completions.every(event => event.data.duration_ms >= 0));
  const frames = capture('gateway-parity', events);
  assert.deepEqual(frames.filter(frame => frame.type === 'tool_finished').map(frame => [frame.data.tool_id, frame.data.ok]),
    [['success', true], ['failure', false], ['throws', false]]);
  assert.deepEqual(messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message.content]),
    [['success', 'success full result'], ['failure', 'failure full result'], ['throws', 'Error: fixture failure']]);
});

test('five interleaved graph agents retain identities and the main turn across child completion', () => {
  const events = [e('turn_started', { text: 'fixture' })];
  for (const type of ['graph_node_start', 'tool_call', 'tool_started', 'complete', 'tool_done', 'graph_node_result']) {
    for (let i = 0; i < 5; i++) events.push(e(type, {
      graph_run_id: i < 3 ? 'graph-a' : 'graph-b', node_id: `node-${i % 3}`, sub_agent: 'review',
      call_id: 'same-tool-id', tool: 'shell', args: {}, output: `result ${i}`, status: 'completed',
    }));
  }
  events.push(e('content', { text: 'main answer' }));
  const frames = capture('graph-parity', events);
  const starts = frames.filter(frame => frame.type === 'agent_spawned');
  assert.equal(new Set(starts.map(frame => frame.agent_id)).size, 5);
  for (const start of starts) {
    const own = frames.filter(frame => frame.agent_id === start.agent_id);
    assert.equal(own.length, 6);
    assert.ok(own.every(frame => frame.turn_id === frames[0].turn_id));
    assert.ok(own.every(frame => frame.parent_agent_id === 'main'));
    assert.equal(own.find(frame => frame.type === 'agent_finished').data.ok, true);
  }
  assert.equal(frames.at(-1).agent_id, 'main');
  assert.equal(frames.at(-1).turn_id, frames[0].turn_id);
});

test('additional events have explicit display contracts and cancellation is terminal', () => {
  const frames = capture('display-parity', [
    e('status', { message: 'waiting on network' }), e('phase_update', { stage_name: 'verify' }),
    e('sub_agent_tool_result', { run_id: 'child', output: 'result', success: false }),
    e('approval_denied', { apr_id: 'approval' }), e('paused', { reason: 'user' }),
    e('resumed'), e('cancelled', { message: 'Cancelled.' }), e('content', { text: 'next turn' }),
  ]);
  assert.equal(frames[0].data.progress_key, 'status');
  assert.equal(frames[1].data.cause, 'verify');
  assert.equal(frames[2].agent_id, 'child');
  assert.equal(frames[2].data.level, 'error');
  assert.equal(frames[2].data.progress_key, undefined, 'failure must survive the next progress update');
  assert.equal(frames[3].data.decision, 'deny');
  assert.equal(frames[4].data.activity, 'paused');
  assert.equal(frames[5].data.activity, 'working');
  assert.equal(frames[6].data.outcome, 'cancelled');
  assert.notEqual(frames[6].turn_id, frames[7].turn_id);
  const failed = capture('error-only-parity', [
    e('tool_done', { call_id: 'failed-tool', error: 'full error details' }),
    e('test_result', { success: false, summary: 'check failed' }),
  ]);
  assert.equal(failed[0].data.ok, false);
  assert.equal(failed[0].data.output, 'full error details');
  assert.equal(failed[1].data.ok, false);
});

test('live display subscribers cannot mutate canonical tool arguments', () => {
  const source = e('tool_call', { tool: 'shell', call_id: 'readonly', args: { nested: { command: 'original' } } });
  const unsubscribe = registerBroadcaster(frame => {
    frame.data.args.nested.command = 'display mutation';
  }, { schemaVersion: 2, live: true });
  try { tapSseEvent(source, { sessionId: 'readonly-parity' }); }
  finally { unsubscribe(); }
  assert.equal(source.data.args.nested.command, 'original');
});

test('background agent tools retain their turn after the main turn completes', () => {
  const frames = capture('background-parity', [
    e('turn_started'), e('sub_agent_start', { run_id: 'background' }),
    e('tool_call', { run_id: 'background', call_id: 'tool', tool: 'shell', args: {} }),
    e('complete', { summary: 'main done' }),
    e('tool_done', { run_id: 'background', call_id: 'tool', output: 'background result' }),
    e('sub_agent_complete', { run_id: 'background', report: 'background done' }),
    e('content', { text: 'next main turn' }),
  ]);
  assert.equal(frames[2].turn_id, frames[4].turn_id);
  assert.equal(frames[2].agent_id, frames[4].agent_id);
  assert.equal(frames[2].turn_id, frames[5].turn_id);
  assert.notEqual(frames[2].turn_id, frames[6].turn_id);
});
