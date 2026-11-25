import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const view of ['node', 'inline', 'fullscreen']) {
    test(`MCP masked login via ! restores ${view} input without exposing credentials`, { skip: process.platform === 'win32', timeout: 40000 }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-terminal-'));
        const home = path.join(dir, 'home'); fs.mkdirSync(home);
        const script = String.raw`
import os, pty, fcntl, struct, termios, select, subprocess, sys, time, re, signal
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1] + '/scripts')
from tui_test_screen import Screen
screen = Screen(36, 120)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH',36,120,0,0))
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = bytearray(); recent = bytearray(); stage = 0; deadline = time.time()+30
try:
 while child.poll() is None and time.time()<deadline:
  if select.select([master],[],[],0.03)[0]:
   try: chunk=os.read(master,65536)
   except OSError: break
   output.extend(chunk); recent.extend(chunk); screen.feed(chunk)
   if b'\x1b[6n' in chunk: os.write(master,b'\x1b[1;1R')
  visible=re.sub(rb'\s+',b'',screen.text().encode('utf8'))
  plain=re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]',b'',bytes(recent))
  keys=None
  ready=(b'AskBahulam' in visible or b'You' in visible)
  if stage==0 and ready: keys=b'!bahulam mcp add fixture --url https://example.test/mcp --api-key\r'
  elif stage==1 and b'API key (masked' in plain: keys=b'PTY-private-key\r'
  elif stage==2 and b'Press Enter to return' in plain: keys=b'\r'
  elif stage==3 and ready: keys=b'!bahulam mcp list --json\r'
  elif stage==4 and b'Press Enter to return' in plain:
   assert b'api-key' in plain, plain.decode('utf8','replace')
   keys=b'\r'
  elif stage==5 and ready: keys=b'!bahulam mcp login fixture --api-key\r'
  elif stage==6 and b'API key (masked' in plain: keys=b'\x03'
  elif stage==7 and b'Press Enter to return' in plain: keys=b'\r'
  elif stage==8 and ready: keys=b'/help\r'
  elif stage==9 and b'/help' in plain and (b'/model' in plain or b'/resume' in plain):
   assert b'PTY-private-key' not in output, 'credential leaked to terminal output'
   print('terminal ownership, cancellation, return, and subsequent /help passed')
   break
  if keys is not None:
   os.write(master,keys); stage+=1; recent.clear()
 else: raise AssertionError('timeout at stage '+str(stage)+'\n'+output.decode('utf8','replace')[-8000:])
 assert stage==9, 'child exited early at stage '+str(stage)+'\n'+output.decode('utf8','replace')[-8000:]
finally:
 if child.poll() is None:
  os.killpg(child.pid, signal.SIGTERM)
  try: child.wait(timeout=2)
  except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL); child.wait()
 os.close(master); os.close(slave)
`;
        try {
            const result = spawnSync('python3', ['-c', script, root, process.execPath, path.join(root, 'src/terminal/main.mjs')], {
                cwd: dir, encoding: 'utf8', timeout: 35000, maxBuffer: 2 * 1024 * 1024,
                env: { ...process.env, HOME: dir, USERPROFILE: dir, BAHULAM_HOME: home, B0_TOKEN: '', KEPLER_TOKEN: '',
                    BAHULAM_TUI: view === 'node' ? 'node' : 'rust', BAHULAM_TUI_MODE: view, TARANG_ENV: 'local', BAHULAM_TUI_MOUSE: '0',
                    BAHULAM_TUI_BINARY: path.join(root, 'rust/target/debug/bahulam-tui'), BAHULAM_THEME: 'dark', FORCE_COLOR: '3', NO_COLOR: '',
                    BAHULAM_AUTO_ATTACH: '0', BAHULAM_NO_PREFLIGHT: '1', BAHULAM_SKIP_AUTO_REGISTER: 'true', BAHULAM_MODEL_CATALOG_OFFLINE: '1',
                    BAHULAM_SKIP_UPGRADE_CHECK: 'true', BAHULAM_DISABLE_TELEMETRY: '1' },
            });
            assert.equal(result.error, undefined, result.error?.message);
            assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
            const settings = fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8');
            assert.ok(!settings.includes('PTY-private-key'));
            const walk = directory => {
                if (!fs.existsSync(directory)) return;
                for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
                    const target = path.join(directory, file.name);
                    if (file.isDirectory()) walk(target);
                    else if (target.endsWith('.jsonl')) assert.ok(!fs.readFileSync(target, 'utf8').includes('PTY-private-key'));
                }
            };
            walk(home);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
}
