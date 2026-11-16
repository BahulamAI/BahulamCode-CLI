// Read-only rendering audit. Uses synthetic events, an isolated home, the real
// Node projection, and the compiled Rust replay client. It makes no model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = path.join(root, 'rust/target/debug/bahulam-tui');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-event-audit-'));
process.env.BAHULAM_HOME = temp;
process.env.BAHULAM_DAEMON_EVENTLOG = '0';
const { tapSseEvent, registerBroadcaster } = await import('../src/daemon/event-tap.mjs');
const marker = 'AUDIT_VISIBLE';
const event = (type, data) => ({ type, data });
const request = event('tool_call', { call_id: 'tool-1', tool: 'shell', args: { command: 'fixture only' } });
const start = event('tool_started', { call_id: 'tool-1', tool: 'shell' });
const cases = [
  ['assistant stream/final', [event('content_partial', { text: marker }), event('content', { text: marker })]],
  ['normal tool lifecycle', [request, start, event('tool_done', { call_id: 'tool-1', tool: 'shell', output: marker, success: true })]],
  ['failed tool result', [request, start, event('tool_done', { call_id: 'tool-1', tool: 'shell', output: marker, success: false })]],
  ['shell output delta (if emitted)', [request, start, event('tool_output_delta', { call_id: 'tool-1', chunk: marker })]],
  ['agent lifecycle/report', [event('sub_agent_start', { run_id: 'agent-1', type: 'review', task: 'fixture' }), event('sub_agent_complete', { run_id: 'agent-1', report: marker, success: true })]],
  ['agent-attributed text', [event('content_partial', { run_id: 'agent-1', text: marker }), event('content', { run_id: 'agent-1', text: marker })]],
  ['worker status', [event('worker_update', { worker: 'agent-1', status: marker })]],
  ['plan', [event('plan', { items: [{ state: 'running', text: marker }] })]],
  ['diff', [event('file_diff', { path: 'fixture.js', hunks: [{ text: marker }] })]],
  ['approval request', [event('approval_required', { apr_id: 'approval-1', name: 'shell', args: {}, reason: marker })]],
  ['error/reconnect notice', [event('error', { message: marker })]],
  ['turn completion', [event('complete', { summary: marker })]],
  ['thinking', [event('thinking', { message: marker })]],
  ['test result', [event('test_result', { name: marker, summary: marker, ok: true })]],
  ['status progress', [event('status', { message: marker })]],
  ['phase heading', [event('phase_start', { phase: marker })]],
  ['phase update', [event('phase_update', { phase: marker })]],
  ['phase summary', [event('phase_summary', { summary: marker })]],
  ['delegation', [event('delegation', { from: 'main', to: marker })]],
  ['sub-agent tool progress', [event('sub_agent_tool', { run_id: 'agent-1', type: 'review', tool: marker })]],
  ['sub-agent tool result metadata', [event('sub_agent_tool_result', { run_id: 'agent-1', tool: 'shell', output: marker })]],
  ['local stagnation', [event('stagnation', { message: marker })]],
  ['compaction notice', [event('summarize', { summary: marker, message: marker })]],
  ['file change notice', [event('change', { path: marker })]],
  ['goal creation', [event('goal_created', { goal: marker, name: marker })]],
  ['follow-up queued', [event('user_intervention_queued', { message: marker })]],
  ['follow-up accepted', [event('user_intervention_accepted', { message: marker })]],
  ['follow-up delivered', [event('user_intervention_delivered', { message: marker })]],
  ['cancelled', [event('cancelled', { message: marker })]],
  ['paused', [event('paused', { message: marker })]],
  ['resumed', [event('resumed', { message: marker })]],
];
let frames = [];
const unsubscribe = registerBroadcaster(frame => frames.push(frame), { schemaVersion: 2, live: true });
function replay(events, id) {
  frames = [];
  tapSseEvent(event('session_info', { cwd: '/audit-fixture', model: 'no-model-call' }), { sessionId: id });
  for (const item of events) tapSseEvent(item, { sessionId: id });
  const file = path.join(temp, 'events.jsonl');
  fs.writeFileSync(file, frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
  return execFileSync(binary, ['--replay', file, '--plain'], { encoding: 'utf8' });
}
try {
  const results = cases.map(([feature, events], index) => {
    const output = replay(events, `event-audit-${index}`);
    const projected = frames.slice(1).map(frame => frame.type);
    return { feature, inputs: events.map(item => item.type), projected,
      result: output.includes(marker) ? 'rendered' : projected.length ? 'renderer gap' : 'bridge gap' };
  });
  // Match the current gateway loop's actual completion shape, not an idealized fixture.
  const gatewayOutput = replay([request, start, event('tool_done', { tool: 'shell', duration_ms: 0 })], 'gateway-audit');
  const gatewayToolCompletion = {
    requestId: frames[1].data.tool_id, completionId: frames.at(-1).data.tool_id,
    originalToolStillRunning: gatewayOutput.includes('[running] shell'),
    extraUnattributedTool: gatewayOutput.includes('Tool unattributed:'),
  };
  // Match orchestration/events.mjs when no explicit sub-agent run ID exists.
  replay([request, start, event('tool_done', { call_id: 'tool-1', output: marker })].map(item => ({
    ...item, data: { ...item.data, internal: true, sub_agent: 'reviewer', graph_run_id: 'graph-1', node_id: 'node-1' },
  })), 'orchestration-audit');
  console.log(JSON.stringify({
    scope: 'Synthetic projection + Rust plain replay; not an interactive/model-session parity test',
    results,
    gatewayToolCompletion,
    orchestrationToolAgents: frames.slice(1).map(frame => frame.agent_id),
  }, null, 2));
} finally {
  unsubscribe();
  fs.rmSync(temp, { recursive: true, force: true });
}
