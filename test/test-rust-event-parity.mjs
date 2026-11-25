import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalAgent } from '../src/core/local-agent.mjs';
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

test('child turn endings project terminal outcomes even with a progress message', () => {
  const frames = capture('child-turn-outcomes', [
    e('turn_ended', { run_id: 'a', ok: true, message: 'Finished the report' }),
    e('complete', { run_id: 'b', success: false }),
    e('cancelled', { run_id: 'c', message: 'Interrupted by user' }),
  ]);
  assert.deepEqual(frames.map(f => [f.type, f.data.status]), [
    ['agent_status', 'done'], ['agent_status', 'failed'], ['agent_status', 'cancelled'],
  ]);
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

test('usage aliases and per-agent totals survive projection, including completion-only accounting', () => {
  const frames = capture('usage-parity', [
    e('usage_update', { usage: { prompt_tokens: 120, completion_tokens: 30, total_cost_usd: 0.2,
      per_agent: { worker: { usage: { input: 50, output: 20, cost: 0.07 } } } } }),
    e('sub_agent_complete', { run_id: 'worker', usage: { prompt_tokens: 50, completion_tokens: 20, total_cost_usd: 0.07 }, report: 'done' }),
    e('complete', { turn_cost_usd: 0.04 }),
  ]);
  assert.equal(frames[0].data.cost_usd, 0.2);
  assert.equal(frames[0].data.total_tokens, 150);
  assert.deepEqual({ ...frames[0].data.per_agent.worker }, { input_tokens: 50, output_tokens: 20, total_tokens: 70, cost_usd: 0.07 });
  assert.equal(frames[1].data.total_tokens, 70);
  assert.equal(frames[1].data.cost_usd, 0.07);
  assert.equal(frames[2].data.turn_cost_usd, 0.04);
});

test('every declared remote stream event has a presentation route', async () => {
  const { EVENT_TYPES } = await import('../src/core/stream-client.mjs');
  for (const type of Object.values(EVENT_TYPES)) {
    const frames = capture(`coverage-${type}`, [e(type, { message: 'fixture', tool_call_id: 'call', tool: 'read_file' })]);
    assert.equal(frames.length, 1, `unhandled producer event: ${type}`);
  }
});

test('Rust host uses Windows console depth when cmd omits TERM', async () => {
  const { rustColorLevel } = await import('../src/daemon/rust-tui-host.mjs');
  for (const [depth, level] of [[1, 'none'], [4, 'ansi16'], [8, 'ansi256'], [24, 'truecolor']]) {
    const consoleStream = { isTTY: true, getColorDepth: () => depth };
    assert.equal(rustColorLevel({}, 'none', 'win32', consoleStream), level);
    assert.equal(rustColorLevel({ NO_COLOR: '1' }, 'none', 'win32', consoleStream), 'none');
    assert.equal(rustColorLevel({ TERM: 'dumb' }, 'none', 'win32', consoleStream), 'none');
    assert.equal(rustColorLevel({}, 'none', 'win32', { isTTY: false }), 'none');
  }
});

test('local and gateway requests carry scoped context and normal user follow-ups', async () => {
  const projectPrompt = 'Scoped instructions from AGENTS.md';
  const agent = new LocalAgent({ model: 'fixture', toolExecutor: {} });
  let localCalls = 0;
  agent._callLLM = async (system, messages, tools) => {
    assert.ok(system.includes(projectPrompt));
    assert.ok(tools.some(tool => tool.name === 'skill_view'));
    if (!localCalls++) await agent.sendIntervention('switch target\nretain formatting');
    else assert.deepEqual(messages.at(-1), { role: 'user', content: 'switch target\nretain formatting' });
    return { content: [{ type: 'text', text: 'ack' }], stopReason: 'end_turn' };
  };
  for await (const _event of agent.execute('first', { project_context: { prompt_block: projectPrompt } })) {}
  assert.equal(localCalls, 2);
  const interventions = [];
  const messages = [{role:'user', content:'first'}];
  let calls = 0;
  const events = [];
  for await (const event of createAgentLoop({ session:{prompt:'base prompt'}, messages, projectPrompt, interventions,
    gatewayFetch: async ({ messages: outgoing }) => {
      assert.deepEqual(outgoing[0], {role:'system', content:'base prompt\n\n' + projectPrompt});
      if (calls++) assert.deepEqual(outgoing.at(-1), {role:'user',content:'switch target\nretain formatting'});
      else interventions.push({id:'correction',instruction:'switch target\nretain formatting'});
      return { message: { content:'ack' } };
    },
  })) events.push(event);
  assert.equal(calls, 2);
  assert.equal(events.filter(e => e.type === 'user_intervention_delivered').length, 1);
  assert.equal(messages.some(m => m.content.includes(projectPrompt)), false);
});

test('recorded edits preview three changed lines and retain the complete result', () => {
  const diff = {path:'sample.rs', unified:'--- a/sample.rs\n+++ b/sample.rs\n@@ -1,2 +1,4 @@\n context\n-old\n+first\n+second\n+third'};
  const frames = capture('edit-preview', [
    e('tool_done', {call_id:'one', tool:'edit_file', output:'saved', file_diff:diff}),
    e('file_diff', {...diff, call_id:'one'}),
    e('tool_done', {call_id:'failed', success:false, output:'write refused', file_diff:diff}),
    e('file_diff', {...diff, path:'.env', hunks:[{text:'sensitive source'}]}),
    e('tool_done', {call_id:'large', output:'saved', file_diff:{...diff, unified:diff.unified + '\n+' + 'x'.repeat(5000)}}),
  ]);
  assert.equal(frames[0].data.preview, '-old\n+first\n+second');
  assert.equal(frames[0].data.output, 'saved\n\n' + diff.unified);
  assert.equal(frames[1].data.preview, frames[0].data.preview);
  assert.equal(frames[2].data.preview, 'write refused');
  assert.doesNotMatch(JSON.stringify(frames[3].data), /sensitive source|first/);
  assert.ok(frames[4].payload_ref);
  assert.equal(frames[4].data.preview, frames[0].data.preview);
});
