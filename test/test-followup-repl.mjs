/** Real raw-mode REPL + loopback SSE server. No model, tools, or real credentials. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// Python's standard-library PTY lets this test exercise the actual raw input
// dock/listener without adding a native npm dependency.
if (process.platform === 'win32' || spawnSync('python3', ['-c', 'import pty']).status !== 0) {
  console.log('SKIP follow-up REPL integration: requires POSIX and Python 3 pty.');
  process.exit(0);
}
const bridge = `
import os, pty, select, signal, struct, subprocess, sys, termios, fcntl
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
def stop(*args):
    raise KeyboardInterrupt()
signal.signal(signal.SIGTERM, stop)
try:
    while child.poll() is None:
        ready, _, _ = select.select([master, 0], [], [], 0.1)
        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if not data:
                sys.exit(child.wait(timeout=3) if fd == master else 0)
            os.write(1 if fd == master else master, data)
except KeyboardInterrupt:
    pass
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
`;
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-followup-repl-')));
const entry = fileURLToPath(new URL('../src/terminal/main.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (const outcome of ['late-accepted', 'delivered', 'cancelled']) {
    const project = path.join(fixture, outcome), home = path.join(project, 'home');
    fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'package.json'), '{}');
    let child, output = '', stream, interventionId;
    const turns = [];
    const records = () => {
      const dir = path.join(home, 'projects', project.replaceAll('/', '-'));
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(file => file.endsWith('.jsonl')).flatMap(file =>
        fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    };
    const hasState = status => records().some(row => row.event?.data?.intervention_id === interventionId && row.event?.data?.status === status);
    const until = async (predicate, label) => {
      const deadline = Date.now() + 12000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(outcome + ': timed out waiting for ' + label + '\n' + output);
        await delay(20);
      }
    };
    const enter = async text => {
      child.stdin.write(text);
      // A single text+newline chunk intentionally means clipboard paste in
      // this CLI; model a separately pressed Enter key instead.
      await delay(80);
      child.stdin.write('\r');
    };
    const emit = (res, type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
    let serverError;
    const server = http.createServer((req, res) => { void handleRequest(req, res).catch(error => {
      serverError = error;
      res.writeHead(500); res.end(error.message);
    }); });
    async function handleRequest(req, res) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (req.url === '/api/execute') {
        const body = JSON.parse(raw); turns.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Task-ID': 'fixture-task' });
        emit(res, 'session_info', { session_id: body.session_id, task_id: 'fixture-task' });
        if (turns.length === 1) {
          stream = res;
          emit(res, 'status', { message: 'RACE_READY' });
        } else {
          emit(res, 'content', { text: 'SECOND_DONE' });
          emit(res, 'complete', { summary: 'SECOND_DONE' }); res.end();
        }
      } else if (req.url === '/api/intervention/fixture-task') {
        const body = JSON.parse(raw); interventionId = body.intervention_id;
        assert.ok(records().some(row => row.type === 'user' && row.intervention_id === interventionId), 'saved before POST');
        if (outcome === 'delivered') emit(stream, 'user_intervention_delivered', { intervention_id: interventionId });
        emit(stream, outcome === 'cancelled' ? 'cancelled' : 'complete', { summary: 'FIRST_DONE' });
        stream.end();
        // The old REPL had already drained its next-turn queue by this point.
        await delay(250);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted', intervention_id: interventionId }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ github_username: 'fixture', models: [] }));
      }
    }
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      child = spawn('python3', ['-u', '-c', bridge, process.execPath, entry], {
        cwd: project, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, BAHULAM_HOME: home, B0_TOKEN: 'fixture-only', KEPLER_TOKEN: '',
          BAHULAM_RUNTIME_MODE: 'remote', BAHULAM_USE_GATEWAY_LOOP: '0', BAHULAM_NO_PREFLIGHT: '1',
          BAHULAM_MODEL_CATALOG_OFFLINE: '1', BAHULAM_SKIP_UPGRADE_CHECK: 'true', BAHULAM_SKIP_AUTO_REGISTER: 'true',
          BAHULAM_AUTO_ATTACH: '0', BAHULAM_DISABLE_TELEMETRY: '1', BAHULAM_PLAIN: '0',
          BAHULAM_FIXED_INPUT: '1', NO_COLOR: '1', TERM: 'xterm-256color',
          TARANG_BACKEND_URL: 'http://127.0.0.1:' + server.address().port },
      });
      for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { output += String(chunk); });
      await until(() => output.includes('You ›'), 'startup');
      await enter('initial task');
      await until(() => output.includes('RACE_READY'), 'active execution');
      await enter('also check the followup');
      await until(() => hasState(outcome === 'late-accepted' ? 'completed' : outcome === 'delivered' ? 'delivered' : 'held'), 'durable outcome');
      await delay(350);
      if (serverError) throw serverError;
      assert.equal(turns.length, outcome === 'late-accepted' ? 2 : 1, 'one promotion only, and none after delivery/cancel');
      if (turns.length === 2) {
        assert.equal(turns[1].instruction, 'also check the followup');
        assert.equal(turns[1].messages.filter(row => row.role === 'user' && row.content === turns[1].instruction).length, 1);
      }
      assert.equal(records().filter(row => row.type === 'user' && row.intervention_id === interventionId).length, 1);
      await enter('/exit');
      await until(() => child.exitCode != null, 'CLI exit');
      assert.equal(child.exitCode, 0);
      console.log('  ✓ raw REPL follow-up: ' + outcome);
    } finally {
      if (child && child.exitCode == null) {
        const exited = once(child, 'exit'); child.kill(); await exited;
      }
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
