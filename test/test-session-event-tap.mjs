/**
 * PRD-092 Slice B.3 — event tap smoke test.
 *
 * Run: `node test/test-session-event-tap.mjs`
 * Uses a scratch BAHULAM_HOME so nothing lands in ~/.bahulam.
 *
 * Verifies:
 *   1. Off by default (BAHULAM_DAEMON_EVENTLOG unset → no-op).
 *   2. Enabled: SSE→PRD-092 event mapping + data projection.
 *   3. turn_id stamped when passed.
 *   4. Session id change closes old log, opens new.
 *   5. Missing sessionId → skip silently.
 *   6. Tap tolerates underlying writeEvent errors.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b0-evtap-'));
process.env.BAHULAM_HOME = tmp;

// Dynamic import AFTER BAHULAM_HOME is set so paths.mjs resolves to tmp.
const { tapSseEvent, closeActiveEventLog } = await import('../src/daemon/event-tap.mjs');
const { readAllEvents, mintSessionId } = await import('../src/core/event-log.mjs');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  ', msg);
}

const sessionId = mintSessionId();

// 1. Disabled by default — tap should be a no-op.
delete process.env.BAHULAM_DAEMON_EVENTLOG;
tapSseEvent({ type: 'tool_request', data: { tool: 'bash', args: { cmd: 'ls' } } }, { sessionId });
await new Promise(r => setTimeout(r, 50));
const disabledEvents = await readAllEvents({ sessionId });
assert(disabledEvents.length === 0, 'no events written when BAHULAM_DAEMON_EVENTLOG unset');

// 2. Enabled — several event types map through.
process.env.BAHULAM_DAEMON_EVENTLOG = '1';
tapSseEvent(
  { type: 'tool_request', data: { tool: 'bash', args: { cmd: 'ls' }, tool_call_id: 'tc_1' } },
  { sessionId, turnId: 't1' }
);
tapSseEvent(
  { type: 'tool_result', data: { tool_call_id: 'tc_1', output: 'file1\nfile2', duration_ms: 42 } },
  { sessionId, turnId: 't1' }
);
tapSseEvent(
  { type: 'approval_required', data: { apr_id: 'apr_1', kind: 'bash', subject: 'rm -rf /' } },
  { sessionId }
);
tapSseEvent(
  { type: 'complete', data: { summary: 'done', duration_ms: 1000 } },
  { sessionId, turnId: 't1' }
);
// Both ordinary progress and context handoffs are notices in the Rust views.
tapSseEvent({ type: 'status', data: { message: 'thinking...' } }, { sessionId });

tapSseEvent({ type: 'summarize_progress', data: {
  phase: 'mid_turn', state: 'started', before_tokens: 442572, threshold: 138000, collapsed_messages: 8,
} }, { sessionId });
tapSseEvent({ type: 'summarize', data: {
  phase: 'mid_turn', collapsed_messages: 8, kept_recent: 2, before_tokens: 442572, threshold: 138000,
} }, { sessionId });
tapSseEvent({ type: 'unmapped_event', data: {} }, { sessionId });
await closeActiveEventLog();

const events = await readAllEvents({ sessionId });
assert(events.length === 7, `7 events written (got ${events.length})`);
assert(events[0].type === 'tool_requested' && events[0].data.name === 'bash', 'tool_request → tool_requested with projected data');
assert(events[0].data.tool_id === 'tc_1', 'tool_id projected from tool_call_id');
assert(events[1].type === 'tool_finished' && events[1].data.summary === 'file1\nfile2', 'tool_result projection');
assert(events[1].data.duration_ms === 42, 'duration_ms preserved');
assert(events[2].type === 'approval_required' && events[2].data.apr_id === 'apr_1', 'approval_required passthrough');
assert(events[3].type === 'turn_ended' && events[3].data.ok === true, 'complete → turn_ended');
assert(events[4].type === 'notice' && events[4].data.source === 'status', 'status → progress notice');
assert(events[5].data.title === 'Summarizing context…' && events[5].data.level === 'running'
  && events[5].data.progress_key === events[6].data.progress_key, 'in-flight and completed summary share one notice');
assert(events[6].data.title === 'Context summarized' && events[6].data.cause.includes('442572 / 138000'),
  'context handoff displays the estimate and trigger');
assert(events[0].turn_id === 't1', 'turn_id stamped from opts');
assert(events[2].turn_id === 't1', 'approval inherits active turn when not provided');
assert(events.every(e => e.v === 2 && e.agent_id && e.id), 'v2 identity on every event');

// 3. Session id change closes old and opens new.
const sessionId2 = mintSessionId();
tapSseEvent({ type: 'session_info', data: { cwd: '/x', model: 'gpt-5' } }, { sessionId: sessionId2 });
await closeActiveEventLog();
const events2 = await readAllEvents({ sessionId: sessionId2 });
assert(events2.length === 1 && events2[0].type === 'session_started', 'new session id → new log');
assert(events2[0].data.cwd === '/x', 'session_started projection');

const handoff = { context: 'Two tracks ongoing.\nReview release notes.', findings: ['x'.repeat(5000)] };
tapSseEvent({ type: 'tool_request', data: { tool: 'plan', args: { handoff, task: 'Plan the release' } } }, { sessionId: sessionId2 });
await closeActiveEventLog();
const plan = (await readAllEvents({ sessionId: sessionId2 })).at(-1);
assert(plan.payload_ref && !plan.data.args && plan.data.primary === 'Two tracks ongoing. Review release notes.',
  'large planning requests retain their handoff context when arguments are stored separately');

// 4. Missing sessionId → skip silently.
tapSseEvent({ type: 'tool_request', data: {} }, { sessionId: undefined });
assert(true, 'tap tolerates missing sessionId without throwing');

// 5. Bogus data doesn't propagate errors.
tapSseEvent({ type: 'tool_request', data: null }, { sessionId: sessionId2 });
await closeActiveEventLog();
assert(true, 'tap does not propagate underlying writeEvent errors');

console.log('\nALL OK');
fs.rmSync(tmp, { recursive: true, force: true });
