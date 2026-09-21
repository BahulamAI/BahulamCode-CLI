/** Real CLI process + local fake account API; no real tokens or browser login. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { BahulamAuth } from '../src/auth/bahulam-auth.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-auth-repl-'));
const previousHome = process.env.BAHULAM_HOME;
process.env.BAHULAM_HOME = path.join(fixture, 'shared-home');
const project = path.join(fixture, 'another-project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'package.json'), '{}');
let child;
let watchdog;
let output = '';
let requests = 0;
let unavailable = false;
const observers = new Set();
const notify = () => { for (const observer of observers) observer(); };
const server = http.createServer((req, res) => {
  assert.equal(req.url, '/api/user/me');
  requests++;
  const id = req.headers.authorization === 'Bearer fixture-alice' ? 'alice' : 'bob';
  res.writeHead(unavailable ? 503 : 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id, github_username: id, email: id + '@example.test' }));
  notify();
});
function until(predicate, label) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); observers.delete(check); };
    const check = () => { if (predicate()) { cleanup(); resolve(); } };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for ' + label + '\n' + output)); }, 8000);
    observers.add(check);
  });
}
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  child = spawn(process.execPath, [fileURLToPath(new URL('../src/terminal/main.mjs', import.meta.url))], {
    cwd: project, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, B0_TOKEN: '', KEPLER_TOKEN: '', BAHULAM_NO_PREFLIGHT: '1',
      BAHULAM_SKIP_UPGRADE_CHECK: 'true', BAHULAM_SKIP_AUTO_REGISTER: 'true',
      BAHULAM_AUTO_ATTACH: '0', BAHULAM_PLAIN: '1', BAHULAM_DISABLE_TELEMETRY: '1',
      TARANG_BACKEND_URL: 'http://127.0.0.1:' + server.address().port },
  });
  watchdog = setTimeout(() => child.kill(), 20000);
  watchdog.unref();
  const exited = once(child, 'exit');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += String(chunk); notify(); });
  await until(() => output.includes('Local session ready'), 'initial prompt');
  child.stdin.write('/whoami\n');
  await until(() => output.includes('Not logged in. Run /login.'), 'initial signed-out check');
  assert.equal(requests, 0);
  const login = new BahulamAuth();
  login.saveCredentials({ token: 'fixture-alice' });
  await until(() => requests === 1, 'idle terminal to discover shared login');
  child.stdin.write('/status\n');
  await until(() => /User\s+alice/.test(output), 'shared account on status');
  assert.equal(requests, 1, 'status reuses the profile fetched by the shared-auth poll');

  login.saveCredentials({ token: 'fixture-bob' });
  child.stdin.write('/whoami\n');
  await until(() => output.includes('bob@example.test'), 'account switch without CLI restart');
  unavailable = true;
  const offlineOffset = output.length;
  child.stdin.write('/whoami\n');
  await until(() => output.slice(offlineOffset).includes('Credentials saved; could not verify your account'), 'cached profile is not presented as fresh verification');
  assert.ok(!output.slice(offlineOffset).includes('bob@example.test'));
  unavailable = false;
  login.logout();
  const logoutOffset = output.length;
  child.stdin.write('/whoami\n');
  await until(() => output.slice(logoutOffset).includes('Not logged in. Run /login.'), 'shared logout');

  unavailable = true;
  login.saveCredentials({ token: 'fixture-alice' });
  const nextOfflineOffset = output.length;
  child.stdin.write('/whoami\n');
  await until(() => output.slice(nextOfflineOffset).includes('Credentials saved; could not verify your account'), 'honest offline account status');
  assert.ok(!output.includes('fixture-alice') && !output.includes('fixture-bob'), 'no token values displayed');
  child.stdin.write('/exit\n');
  assert.equal((await exited)[0], 0);
  console.log('Live CLI shared-login regression passed: idle discovery, account switch, logout and offline profile status.');
} finally {
  clearTimeout(watchdog);
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  if (previousHome === undefined) delete process.env.BAHULAM_HOME; else process.env.BAHULAM_HOME = previousHome;
  fs.rmSync(fixture, { recursive: true, force: true });
}
