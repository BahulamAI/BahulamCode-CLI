/**
 * PRD-092 Slice B.4 — socket server smoke test.
 *
 * Run: `node tests/prd092/socket-server.smoke.mjs`
 *
 * Boots a socket server against a scratch BAHULAM_HOME session, pre-populates
 * the event log with a few events (via the tap), connects a client over the
 * Unix socket, verifies:
 *   1. hello → hello_ok + replay of pre-existing events + attach_joined
 *   2. Live broadcast: new tap writes surface on the connected client
 *   3. approve command → dispatched to the registered handler
 *   4. Unknown command → command_error { code: unknown_type }
 *   5. Deferred command (interrupt) → command_error { code: not_implemented }
 *   6. Bye → attach_left frame + socket closes
 *   7. Server close cleans up the socket file
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b0-sock-'));
process.env.BAHULAM_HOME = tmp;
process.env.BAHULAM_DAEMON_EVENTLOG = '1';

const { tapSseEvent, closeActiveEventLog, registerBroadcaster } = await import('../../src/daemon/event-tap.mjs');
const { startSocketServer } = await import('../../src/daemon/socket-server.mjs');
const { mintSessionId, readAllEvents } = await import('../../src/core/event-log.mjs');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  ', msg);
}

const sessionId = mintSessionId();

// Pre-populate the event log with three events (via the tap so seq numbering is real).
tapSseEvent({ type: 'session_info', data: { cwd: '/tmp/x', model: 'm', product: 'p' } }, { sessionId });
tapSseEvent({ type: 'tool_request', data: { tool: 'bash', tool_call_id: 'tc_a' } }, { sessionId, turnId: 't1' });
tapSseEvent({ type: 'tool_result', data: { tool_call_id: 'tc_a', output: 'ok', duration_ms: 5 } }, { sessionId, turnId: 't1' });
await closeActiveEventLog();  // flush + close

const persisted = await readAllEvents({ sessionId });
assert(persisted.length === 3, `pre-populated 3 events (got ${persisted.length})`);

// Boot the server with an approve handler.
let approveCalls = [];
const server = await startSocketServer({
  sessionId,
  onCommand: {
    approve: async (payload, attachId) => { approveCalls.push({ payload, attachId }); },
    deny: async (payload, attachId) => { approveCalls.push({ payload, attachId, denied: true }); },
  },
});
assert(fs.existsSync(server.sockPath), 'socket file created');
const perms = (fs.statSync(server.sockPath).mode & 0o777).toString(8);
assert(perms === '600' || perms === '700', `socket perms are 0600-ish (got 0${perms})`);

// Wire tap broadcasts to the server so live events fan out on the socket.
const unregister = registerBroadcaster(evt => server.broadcastEvent(evt));

// Connect a client.
const client = net.createConnection(server.sockPath);
await new Promise(r => client.once('connect', r));

const receivedFrames = [];
let buf = '';
client.setEncoding('utf-8');
client.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) receivedFrames.push(JSON.parse(line));
  }
});

async function waitFor(pred, {timeoutMs = 2000, description = 'condition'} = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  console.error('FAIL: timed out waiting for', description, 'frames so far:', JSON.stringify(receivedFrames, null, 2));
  process.exit(1);
}

// Overall test timeout — if we hang anywhere for 20s, kill ourselves with a
// clear message rather than let a background runner sit forever.
const _overallTimer = setTimeout(() => {
  console.error('FAIL: overall test exceeded 20s — likely bye/close hang');
  console.error('receivedFrames:', receivedFrames.map(f => f.type).join(', '));
  process.exit(1);
}, 20_000);
_overallTimer.unref();

// 1. hello handshake — expect hello_ok + replay + attach_joined
client.write(JSON.stringify({ type: 'hello', attach_id: 'att_test', last_seq: 0, kind: 'local' }) + '\n');
await waitFor(() => receivedFrames.some(f => f.type === 'attach_joined'), { description: 'attach_joined' });

const helloOk = receivedFrames.find(f => f.type === 'hello_ok');
assert(helloOk && helloOk.data.session_id === sessionId, 'hello_ok returns session_id');

const rbStart = receivedFrames.find(f => f.type === 'replay_batch_start');
const rbEnd = receivedFrames.find(f => f.type === 'replay_batch_end');
assert(rbStart && rbEnd, 'replay bracketed by replay_batch_start/end');
assert(rbStart.data.from_seq === 1 && rbEnd.data.to_seq === 3, 'replay covers seqs 1..3');

const replayedEvents = receivedFrames.filter(f => [1, 2, 3].includes(f.seq));
assert(replayedEvents.length === 3, `3 events replayed (got ${replayedEvents.length})`);
assert(replayedEvents[0].type === 'session_started', 'first replayed event is session_started');
assert(replayedEvents[1].type === 'tool_call' && replayedEvents[1].turn_id === 't1', 'tool_call carries turn_id');

// 2. Live broadcast — tap a new event, verify the client receives it.
const beforeLive = receivedFrames.length;
tapSseEvent({ type: 'tool_request', data: { tool: 'read', tool_call_id: 'tc_b' } }, { sessionId, turnId: 't2' });
await waitFor(
  () => receivedFrames.length > beforeLive && receivedFrames[receivedFrames.length - 1].seq === 4,
  { description: 'live tool_call event' }
);
const live = receivedFrames[receivedFrames.length - 1];
assert(live.type === 'tool_call' && live.data.name === 'read', 'live event landed with correct type');
assert(live.turn_id === 't2', 'live event has turn_id');

// 3. approve command → handler is invoked with payload and attachId.
client.write(JSON.stringify({ type: 'approve', attach_id: 'att_test', data: { apr_id: 'apr_9', note: 'lgtm' } }) + '\n');
await waitFor(() => approveCalls.length > 0, { description: 'approve handler called' });
assert(approveCalls[0].payload.apr_id === 'apr_9', 'approve payload delivered to handler');
assert(approveCalls[0].attachId?.startsWith('att_'), 'attachId assigned server-side');

// 4. Unknown command → command_error
const beforeUnk = receivedFrames.length;
client.write(JSON.stringify({ type: 'nonsense_command', attach_id: 'att_test' }) + '\n');
await waitFor(
  () => receivedFrames.slice(beforeUnk).some(f => f.type === 'command_error' && f.data.code === 'unknown_type'),
  { description: 'command_error unknown_type' }
);
assert(true, 'unknown command → command_error unknown_type');

// 5. Deferred command → command_error not_implemented
const beforeDef = receivedFrames.length;
client.write(JSON.stringify({ type: 'interrupt', attach_id: 'att_test' }) + '\n');
await waitFor(
  () => receivedFrames.slice(beforeDef).some(f => f.type === 'command_error' && f.data.code === 'not_implemented'),
  { description: 'command_error not_implemented' }
);
assert(true, 'deferred command → command_error not_implemented');

// 6. Bye → attach_left + peer half-closes
const beforeBye = receivedFrames.length;
const clientEnded = new Promise(r => client.once('end', r));
client.write(JSON.stringify({ type: 'bye', attach_id: 'att_test' }) + '\n');
await waitFor(
  () => receivedFrames.slice(beforeBye).some(f => f.type === 'attach_left'),
  { description: 'attach_left frame' }
);
// Node emits 'close' only when both sides are closed. Server called
// sock.end() → client sees 'end' (peer's write side is done). We then
// end our own write side to complete the four-way close.
await clientEnded;
client.end();
assert(true, 'bye elicits attach_left and peer half-close');

// 7. Server close cleans up the socket file.
unregister();
await server.close();
await closeActiveEventLog();
assert(!fs.existsSync(server.sockPath), 'server.close removed the socket file');

console.log('\nALL OK');
fs.rmSync(tmp, { recursive: true, force: true });
