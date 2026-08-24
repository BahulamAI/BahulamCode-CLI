/**
 * PRD-092 Slice C — attach client smoke test.
 * Run: node tests/prd092/attach-client.smoke.mjs
 *
 * Boots a real socket server with a seeded event log, invokes attachToSession
 * from a spawned child (so stdin/stdout are separable), pipes the child's
 * stderr+stdout to buffers, and verifies:
 *   1. Banner prints on connect.
 *   2. Replay batch summary line ("… replayed N event(s) …") appears.
 *   3. Live event lands.
 *   4. Sending 'a' key answers an approval → approve command reaches server.
 *   5. Sending 'q' → bye → child exits with code 0.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b0-att-'));
process.env.BAHULAM_HOME = tmp;
process.env.BAHULAM_DAEMON_EVENTLOG = '1';

const { tapSseEvent, closeActiveEventLog, registerBroadcaster } = await import('../../src/daemon/event-tap.mjs');
const { startSocketServer } = await import('../../src/daemon/socket-server.mjs');
const { mintSessionId, writeSessionMeta } = await import('../../src/core/event-log.mjs');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  ', msg);
}

const sessionId = mintSessionId();
await writeSessionMeta({ sessionId, meta: { cwd: '/tmp/prd092', model: 'test-model', opened_at: new Date().toISOString() } });

// Seed 3 events so the attach client has something to replay.
tapSseEvent({ type: 'session_info', data: { cwd: '/tmp/prd092', model: 'test-model', session_id: sessionId } }, { sessionId });
tapSseEvent({ type: 'tool_request', data: { tool: 'bash', tool_call_id: 'tc_1', args: { cmd: 'ls' } } }, { sessionId, turnId: 't1' });
tapSseEvent({ type: 'tool_result', data: { tool_call_id: 'tc_1', output: 'file1\nfile2', duration_ms: 5 } }, { sessionId, turnId: 't1' });
await closeActiveEventLog();

// Boot server with an approve handler that records the call.
let approveCalls = [];
const server = await startSocketServer({
  sessionId,
  onCommand: {
    approve: async (payload, attachId) => { approveCalls.push({ payload, attachId }); },
    deny: async (payload, attachId) => { approveCalls.push({ payload, attachId, denied: true }); },
    interrupt: async () => { approveCalls.push({ interrupt: true }); },
  },
});
const unregister = registerBroadcaster(evt => server.broadcastEvent(evt));

// Spawn the attach client as a subprocess so stdin/stdout are isolated.
const child = spawn(process.execPath, [
  '-e',
  `
    process.env.BAHULAM_HOME = ${JSON.stringify(tmp)};
    const { attachToSession } = await import(${JSON.stringify(path.resolve('src/daemon/attach-client.mjs'))});
    const code = await attachToSession(${JSON.stringify(sessionId)});
    process.exit(code || 0);
  `,
], { stdio: ['pipe', 'pipe', 'pipe'] });

let out = '';
let err = '';
child.stdout.setEncoding('utf-8').on('data', c => { out += c; });
child.stderr.setEncoding('utf-8').on('data', c => { err += c; });

const childExited = new Promise((resolve) => child.on('exit', code => resolve(code)));

async function waitFor(pred, ms, desc) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 30));
  }
  console.error('FAIL: timed out waiting for', desc);
  console.error('stderr:', err);
  console.error('stdout:', out);
  child.kill();
  process.exit(1);
}

// 1. Banner
await waitFor(() => err.includes('bahulam attach') && err.includes(sessionId), 3000, 'banner');
assert(true, 'banner printed with session id');

// 2. Replay summary
await waitFor(() => out.includes('replayed') || out.includes('event(s)'), 3000, 'replay summary line');
assert(true, 'replay summary line appears');

// 3. Live event — emit a new tool_call, expect it in stdout.
tapSseEvent({ type: 'tool_request', data: { tool: 'read', tool_call_id: 'tc_live', args: { path: '/x' } } }, { sessionId, turnId: 't2' });
await waitFor(() => out.includes('read') && out.includes('path=/x'), 3000, 'live tool_call rendered');
assert(true, 'live event surfaces in stdout');

// 4. Emit an approval, send 'a' → approve command reaches server.
tapSseEvent({ type: 'approval_required', data: { apr_id: 'apr_smoke', kind: 'bash', subject: 'rm -rf /tmp/x' } }, { sessionId });
await waitFor(() => out.includes('approval') && out.includes('apr_smoke') || out.includes('rm -rf'), 3000, 'approval prompt rendered');
child.stdin.write('a');  // send key
await waitFor(() => approveCalls.some(c => c.payload?.apr_id === 'apr_smoke'), 3000, 'approve command dispatched');
assert(true, 'a-key sends approve command with apr_id');

// 5. 'q' → bye → child exit(0)
child.stdin.write('q');
const exitCode = await Promise.race([
  childExited,
  new Promise(r => setTimeout(() => r('timeout'), 5000)),
]);
assert(exitCode === 0, `child exited cleanly on q (exit=${exitCode})`);

unregister();
await server.close();
await closeActiveEventLog();

console.log('\nALL OK');
fs.rmSync(tmp, { recursive: true, force: true });
