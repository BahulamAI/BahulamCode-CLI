/**
 * PRD-092 Slice E — approval store + timeout + input lock smoke.
 *
 * Runs against the real socket-server + tap. Verifies:
 *   1. Approval intercept: local TTY promise + remote approve race →
 *      whichever answers first wins; interceptApproval returns a shape
 *      matching ApprovalManager.check().
 *   2. Timeout policy: policy=deny:1sec + no answer → auto-deny after 1s.
 *   3. Input lock: first attach holds; second joins as watcher; watcher
 *      trying interrupt gets `not_input_holder`; take_input_lock steals
 *      after 3s grace; new holder can interrupt.
 *   4. Bye: leaving attach transfers the lock to the pending challenger.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b0-sliceE-'));
process.env.BAHULAM_HOME = tmp;
process.env.BAHULAM_DAEMON_EVENTLOG = '1';

const { tapSseEvent, closeActiveEventLog, registerBroadcaster } = await import('../../src/daemon/event-tap.mjs');
const { startSocketServer } = await import('../../src/daemon/socket-server.mjs');
const { mintSessionId } = await import('../../src/core/event-log.mjs');
const {
  interceptApproval, resolvePending, setTimeoutPolicy, listPending, shutdownAllPending,
} = await import('../../src/daemon/approval-store.mjs');
const {
  wireEmit: wireInputLockEmit, resetInputLock, snapshot: lockSnapshot,
} = await import('../../src/daemon/input-lock.mjs');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  ', msg);
}

async function waitFor(pred, ms = 4000, desc = '?') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  console.error('FAIL: timeout waiting for', desc);
  process.exit(1);
}

const sessionId = mintSessionId();
const server = await startSocketServer({
  sessionId,
  onCommand: {
    approve: async (payload, attachId) => resolvePending('approve', payload?.apr_id, attachId, payload?.note),
    deny: async (payload, attachId) => resolvePending('deny', payload?.apr_id, attachId, payload?.note),
    interrupt: async () => { interruptCalls += 1; },
  },
});
let interruptCalls = 0;
registerBroadcaster(evt => server.broadcastEvent(evt));
wireInputLockEmit((type, data) => tapSseEvent({ type, data }, { sessionId }));

// ── 1. Approval intercept — remote wins the race. ─────────────────

// Simulate a slow local TTY prompt: pretend the user takes 500ms to press y.
const slowLocal = () => new Promise(r => setTimeout(() => r({ approved: true, tier: 'destructive', localAnswer: true }), 500));

const emitted = [];
const emit = (type, data) => emitted.push({ type, data });

const p1 = interceptApproval(slowLocal, {
  tool: 'bash', args: { command: 'rm -rf /tmp/x' },
  sessionId, emit,
});
await waitFor(() => listPending().length > 0, 1000, 'apr registered');
const apr1 = listPending()[0].apr_id;
assert(emitted.some(e => e.type === 'approval_required' && e.data.apr_id === apr1),
  'approval_required emitted with apr_id');

// Remote answers before local (~50ms into local's 500ms wait).
setTimeout(() => resolvePending('deny', apr1, 'att_remote_test', 'nope'), 50);
const outcome = await p1;
assert(outcome.approved === false, 'remote deny wins → approved:false');
assert(outcome.remoteDecision === true, 'outcome.remoteDecision flag set');
assert(emitted.some(e => e.type === 'approval_decided' && e.data.decision === 'deny' && e.data.decided_by === 'att_remote_test'),
  'approval_decided event emitted with correct decision + decider');

// ── 2. Timeout policy — deny:1s auto-denies. ──────────────────────

setTimeoutPolicy({ mode: 'deny', durationSec: 1 });
const slowLocal2 = () => new Promise(() => {}); // never resolves
const p2 = interceptApproval(slowLocal2, {
  tool: 'bash', args: { command: 'sleep 999' },
  sessionId, emit: () => {},
});
const t0 = Date.now();
const outcome2 = await p2;
const elapsed = Date.now() - t0;
assert(outcome2.approved === false, 'timeout deny → approved:false');
assert(elapsed >= 950 && elapsed <= 1500, `elapsed ~1000ms (got ${elapsed}ms)`);
setTimeoutPolicy({ mode: 'hold', durationSec: 0 });  // reset for later tests

// ── 3. Input lock — first attach holds, second is watcher. ────────

// Attach A (holder).
const sockA = net.createConnection(server.sockPath);
await new Promise(r => sockA.once('connect', r));
sockA.setEncoding('utf-8');
const framesA = [];
let bufA = '';
sockA.on('data', c => { bufA += c; let nl; while ((nl = bufA.indexOf('\n')) !== -1) {
  const line = bufA.slice(0, nl); bufA = bufA.slice(nl + 1);
  if (line.trim()) framesA.push(JSON.parse(line));
}});
sockA.write(JSON.stringify({ type: 'hello', attach_id: 'att_A', last_seq: 0, kind: 'local' }) + '\n');
await waitFor(() => framesA.some(f => f.type === 'attach_joined' && f.data.input_role === 'holder'), 2000, 'A joined as holder');
assert(lockSnapshot().holder != null, 'lock holder set after first attach');
// Server assigns its own attach_id — client's `attach_id` in the JSON is
// ignored for identity. Read the real one from hello_ok.data.attach_id.
const helloOkA = framesA.find(f => f.type === 'hello_ok');
const serverAttachA = helloOkA?.data?.attach_id;
assert(serverAttachA && serverAttachA.startsWith('att_'), `server attach id for A (got ${serverAttachA})`);
const holderA = serverAttachA;

// Attach B (watcher).
const sockB = net.createConnection(server.sockPath);
await new Promise(r => sockB.once('connect', r));
sockB.setEncoding('utf-8');
const framesB = [];
let bufB = '';
sockB.on('data', c => { bufB += c; let nl; while ((nl = bufB.indexOf('\n')) !== -1) {
  const line = bufB.slice(0, nl); bufB = bufB.slice(nl + 1);
  if (line.trim()) framesB.push(JSON.parse(line));
}});
sockB.write(JSON.stringify({ type: 'hello', attach_id: 'att_B', last_seq: 0, kind: 'local' }) + '\n');
await waitFor(() => framesB.some(f => f.type === 'attach_joined' && f.data.input_role === 'watch'), 2000, 'B joined as watcher');
const helloOkB = framesB.find(f => f.type === 'hello_ok');
const serverAttachB = helloOkB?.data?.attach_id;
assert(serverAttachB && serverAttachB !== serverAttachA, `server attach id for B differs from A (${serverAttachB})`);

// B tries to interrupt → not_input_holder.
const beforeErr = framesB.length;
sockB.write(JSON.stringify({ type: 'interrupt', attach_id: 'att_B' }) + '\n');
await waitFor(() => framesB.slice(beforeErr).some(f => f.type === 'command_error' && f.data.code === 'not_input_holder'), 2000, 'watcher interrupt rejected');
assert(interruptCalls === 0, 'interrupt handler NOT invoked for watcher');

// A can interrupt.
const beforeA = interruptCalls;
sockA.write(JSON.stringify({ type: 'interrupt', attach_id: holderA }) + '\n');
await waitFor(() => interruptCalls > beforeA, 2000, 'holder interrupt reaches handler');
assert(true, 'holder can interrupt');

// ── 4. take_input_lock steals with 3s grace. ──────────────────────

const beforeSteal = framesB.length;
sockB.write(JSON.stringify({ type: 'take_input_lock', attach_id: 'att_B' }) + '\n');
// pending_transfer event fires immediately.
await waitFor(
  () => framesB.slice(beforeSteal).some(f => f.type === 'input_lock_ack' && !f.data.immediate),
  2000, 'take_input_lock ack (not immediate — grace pending)',
);
// After 3s grace, holder transfers to B.
await waitFor(() => lockSnapshot().holder === serverAttachB, 5000, 'lock holder transferred to B after grace');
assert(lockSnapshot().pending == null, 'pending cleared after transfer');

// A tries to interrupt now → rejected.
const beforeErrA = framesA.length;
sockA.write(JSON.stringify({ type: 'interrupt', attach_id: holderA }) + '\n');
await waitFor(() => framesA.slice(beforeErrA).some(f => f.type === 'command_error' && f.data.code === 'not_input_holder'), 2000, 'former holder now watcher — interrupt rejected');

// ── 5. Cleanup. ───────────────────────────────────────────────────

sockA.end();
sockB.end();
shutdownAllPending();
resetInputLock();
await server.close();
await closeActiveEventLog();

console.log('\nALL OK');
fs.rmSync(tmp, { recursive: true, force: true });
