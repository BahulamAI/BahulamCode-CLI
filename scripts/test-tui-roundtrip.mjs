// Exercise the actual Node producer and compiled Rust consumer, including sidecars.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = path.join(root, 'rust/target/debug', process.platform === 'win32' ? 'bahulam-tui.exe' : 'bahulam-tui');
assert.ok(fs.existsSync(binary), 'Build the replay binary with npm run test:tui first.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-roundtrip-'));
process.env.BAHULAM_HOME = temp;
process.env.BAHULAM_DAEMON_EVENTLOG = '1';
const { tapSseEvent, closeActiveEventLog } = await import('../src/daemon/event-tap.mjs');
const { daemonSessionDir } = await import('../src/core/paths.mjs');
try {
  const sessionId = 'sess_roundtrip';
  const tap = (type, data) => tapSseEvent({ type, data }, { sessionId });
  tap('session_info', { cwd: '/roundtrip', model: 'test-only' });
  tap('tool_request', { tool_call_id: 'read_1', tool: 'read_file', args: { path: 'example.js' } });
  tap('tool_result', { tool_call_id: 'read_1', output: 'Read example.js' });
  const message = 'Long message '.repeat(600) + '\x1b]52;c;not-a-clipboard-write\x07FINAL_SENTINEL';
  tap('content_partial', { text: message });
  tap('content', { text: message });
  tap('complete', { summary: 'Round trip complete' });
  await closeActiveEventLog();
  const output = execFileSync(binary, ['--replay', path.join(daemonSessionDir(sessionId), 'events.jsonl'), '--plain'], { encoding: 'utf8' });
  assert.ok(output.includes('Read example.js'));
  assert.ok(output.includes('FINAL_SENTINEL'));
  assert.equal(output.match(/Long message /g).length, 600, 'final message does not duplicate streamed content');
  assert.ok(output.includes('Round trip complete'));
  assert.ok(!output.includes('\x1b') && !output.includes('not-a-clipboard-write'));
  console.log('PASS: Node SSE tap → v2 JSONL + payload sidecars → Rust replay, without duplicate messages or terminal control execution.');
} finally {
  await closeActiveEventLog();
  fs.rmSync(temp, { recursive: true, force: true });
}
