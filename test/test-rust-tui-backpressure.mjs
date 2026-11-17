import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startRustTuiHost } from '../src/daemon/rust-tui-host.mjs';
import { tapSseEvent } from '../src/daemon/event-tap.mjs';

test('a stalled Rust event pipe closes safely and supplies recent recovery events', { timeout: 10_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bahulam-tui-backpressure-'));
  const binary = path.join(dir, 'stalled-client.cjs');
  await fs.writeFile(binary, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
  const previousBinary = process.env.BAHULAM_TUI_BINARY;
  process.env.BAHULAM_TUI_BINARY = binary;
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const host = startRustTuiHost({ maxPendingEventBytes: 512, onExit: resolveExit });
  const sessionId = `stall-${process.pid}-${Date.now()}`;
  t.after(async () => {
    host.close();
    if (previousBinary === undefined) delete process.env.BAHULAM_TUI_BINARY;
    else process.env.BAHULAM_TUI_BINARY = previousBinary;
    await fs.rm(dir, { recursive: true, force: true });
  });

  tapSseEvent({ type: 'content', data: { text: 'recovery transcript '.repeat(50) } }, { sessionId });
  let timeout;
  const exit = await Promise.race([
    exited,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('host did not close the stalled renderer')), 5000); }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(exit.signal, 'SIGTERM');
  assert.ok(exit.recentEvents.some(event => event.type === 'message_end'));
});

test('the host restores saved terminal modes after a SIGKILL under a PTY', {
  skip: process.platform === 'win32', timeout: 12_000,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bahulam-tui-pty-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const driver = path.join(dir, 'driver.mjs');
  const fake = path.join(dir, 'fake-tui.cjs');
  const ready = path.join(dir, 'ready');
  await fs.writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
fs.writeSync(4, JSON.stringify({type:'terminal_state',data:{active:true}})+'\\n');
setTimeout(() => {
  spawnSync('stty', ['raw', '-echo'], {stdio:'inherit'});
  fs.writeFileSync(${JSON.stringify(ready)}, 'yes');
  setInterval(() => {}, 1000);
}, 50);
`, { mode: 0o700 });
  await fs.writeFile(driver, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {startRustTuiHost} from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs', import.meta.url).pathname)};
process.env.BAHULAM_TUI_BINARY = ${JSON.stringify(fake)};
const before = spawnSync('stty', ['-g'], {encoding:'utf8'}).stdout.trim();
let done;
const exited = new Promise(resolve => { done = resolve; });
const host = startRustTuiHost({onExit: done});
const deadline = Date.now() + 5000;
while (!fs.existsSync(${JSON.stringify(ready)})) {
  if (Date.now() > deadline) throw new Error('fake client did not enter raw mode');
  await delay(10);
}
host.child.kill('SIGKILL');
const result = await exited;
const after = spawnSync('stty', ['-g'], {encoding:'utf8'}).stdout.trim();
assert.equal(result.signal, 'SIGKILL');
assert.equal(result.terminalModeRestored, true);
assert.equal(after, before);
process.exit(0);
`);
  const python = "import errno, os, pty, select, subprocess, sys, time\n"
    + "master, slave = pty.openpty()\n"
    + "child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)\n"
    + "os.close(slave)\n"
    + "deadline = time.time() + 10\n"
    + "while child.poll() is None and time.time() < deadline:\n"
    + " ready, _, _ = select.select([master], [], [], 0.05)\n"
    + " if ready:\n  try: os.read(master, 65536)\n  except OSError as e:\n   if e.errno != errno.EIO: raise\n"
    + "if child.poll() is None: child.kill(); raise SystemExit('PTY driver timed out')\n"
    + "os.close(master)\n"
    + "raise SystemExit(child.returncode)\n";
  const result = spawnSync('python3', ['-c', python, process.execPath, driver], {
    encoding: 'utf8', timeout: 11_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});


test('direct snapshots obey the same pipe budget', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bahulam-tui-snapshot-'));
  const binary = path.join(dir, 'client.cjs');
  await fs.writeFile(binary, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', {mode: 0o700});
  let done;
  const exited = new Promise(resolve => { done = resolve; });
  const host = startRustTuiHost({env: {...process.env, BAHULAM_TUI_BINARY: binary}, maxPendingEventBytes: 512, onExit: done});
  t.after(async () => { host.close(); await fs.rm(dir, {recursive:true, force:true}); });
  assert.equal(await host.send({type:'transcript_snapshot', data:{text:'x'.repeat(1024)}}), false);
  const result = await exited;
  assert.match(result.failure, /exceeded 512 bytes/);
  assert.equal(await host.send({type:'after_close'}), false);
});
