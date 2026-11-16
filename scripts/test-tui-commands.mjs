// Use the actual CLI dispatcher, session writer and saved-session picker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const mode of ['fresh startup', 'startup resume', 'return to default']) {
  const startupResume = mode !== 'fresh startup';
  test(`real Rust CLI commands from ${mode}`, {
    skip: process.platform === 'win32', timeout: 35000,
  }, () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-command-')));
    const project = path.join(temp, 'project');
    const home = path.join(temp, 'home');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"command-fixture"}');
    const sessions = path.join(home, 'projects', project.replaceAll('/', '-'));
    fs.mkdirSync(sessions, { recursive: true });
    const records = [
      { role: 'user', content: 'Saved question for command test' },
      { role: 'assistant', content: 'SAVED_REPLY_FROM_DISK' },
    ].map(message => ({ type: message.role, cwd: project, sessionId: 'command-fixture',
      timestamp: new Date().toISOString(), message }));
    const savedFile = path.join(sessions, 'command-fixture.jsonl');
    const savedBytes = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    fs.writeFileSync(savedFile, savedBytes);
    const python = String.raw`
import errno, fcntl, os, pty, re, select, signal, struct, subprocess, sys, termios, time
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(path.join(root, 'scripts'))})
from tui_test_screen import Screen
terminal_screen = Screen(36,120)
startup = sys.argv[1] != 'fresh startup'
return_default = sys.argv[1] == 'return to default'
master, slave = pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',36,120,0,0))
original_mode = termios.tcgetattr(slave)
child = subprocess.Popen(sys.argv[2:],stdin=slave,stdout=slave,stderr=slave,close_fds=True,start_new_session=True)
output, stage_output = bytearray(), bytearray()
stage, deadline = (3 if startup else 0), time.time()+24
stage_at = time.time()
pending_keys, next_key_at = bytearray(), 0
try:
 while child.poll() is None and time.time()<deadline:
  if select.select([master],[],[],0.02)[0]:
   try:
    chunk=os.read(master,65536)
    output.extend(chunk)
    stage_output.extend(chunk)
    terminal_screen.feed(chunk)
    if b'\x1b[6n' in chunk: os.write(master,b'\x1b[1;1R')
   except OSError as error:
    if error.errno != errno.EIO: raise
  screen=re.sub(rb'\s+',b'',terminal_screen.text().encode('utf8'))
  recent=re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]',b'',bytes(stage_output))
  keys=None
  if stage==0 and b'AskBahulam' in screen: keys=b'/res'
  elif stage==1 and b'/resume' in screen: keys=b'\t\r'
  elif stage==2 and b'Chooseasavedtranscript.' in screen: keys=b'\r'
  elif stage==3 and b'SAVED_REPLY_FROM_DISK' in screen and (not startup or b'AskBahulam' in screen): keys=b'/new\r'
  elif stage==4 and b'mode:newsession' in screen:
   assert b'SAVED_REPLY_FROM_DISK' not in screen, '/new left the old reply on screen'
   keys=b'/help\r'
  elif stage==5 and b'Command/help' in screen: keys=b'/model status\r'
  elif stage==6 and b'Command/modelstatus' in screen: keys=b'/clear\r'
  elif stage==7 and b'mode:cleared' in screen:
   assert b'Command/help' not in screen and b'Command/modelstatus' not in screen, '/clear left old command cards'
   keys=b'/resume\r'
  elif stage==8 and b'Chooseasavedtranscript.' in screen: keys=b'\x1b'
  elif stage==9 and b'Cancelled.' in screen: keys=b'/resume command-fixture\r'
  elif stage==10 and b'SAVED_REPLY_FROM_DISK' in screen: keys=b'/help\r'
  elif stage==11 and b'Command/help' in screen: keys=b'/tui default\r' if return_default else b'/resume\r'
  elif return_default and stage==12 and b'Default terminal view' in recent:
   assert b'\x1b[?1049l' in stage_output, 'Renderer did not release alternate screen'
   assert b'Goodbye!' not in output, 'View switch quit the session'
   keys=b'/status\r'
  elif return_default and stage==13 and re.search(rb'ID\s+command-fixture',recent): keys=b'/history\r'
  elif return_default and stage==14 and b'SAVED_REPLY_FROM_DISK' in recent:
   assert b'\x1b[?1049h' not in stage_output, 'Default view restarted the Rust renderer'
   keys=b'/exit\r'
  elif not return_default and stage==12 and b'Chooseasavedtranscript.' in screen: keys=b'\x11'
  elif not return_default and stage==13 and time.time()-stage_at > 0.2: keys=b'\x03\x03'
  if keys is not None:
   stage+=1
   stage_at=time.time()
   stage_output.clear()
   if return_default and stage>=13:
    # Node treats a text+newline burst as pasted text awaiting submission.
    # Keep draining dock redraws while typing, so PTY output backpressure
    # cannot block Node and coalesce these events into a paste burst.
    pending_keys = bytearray(keys)
    next_key_at = time.time()+0.1
   else: os.write(master,keys)
  if pending_keys and time.time()>=next_key_at:
   os.write(master,bytes(pending_keys[:1]))
   del pending_keys[:1]
   next_key_at = time.time()+0.04
 if stage!=(15 if return_default else 14) or child.poll()!=0:
  clean=re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]',b'',bytes(output))
  raise Exception('Command flow stalled at stage '+str(stage)+'\n'+terminal_screen.text()+'\n'+clean[-2000:].decode('utf8','replace'))
 while select.select([master],[],[],0.02)[0]: output.extend(os.read(master,65536))
 restored_mode = termios.tcgetattr(slave)
 # macOS sets PENDIN when switching input modes: pending-input retyping is
 # transient kernel state, not a terminal setting the application changed.
 pending_input = getattr(termios, 'PENDIN', 0)
 restored_mode[3] &= ~pending_input
 original_mode[3] &= ~pending_input
 assert restored_mode==original_mode, 'Quit did not restore terminal modes: '+str(restored_mode)+' != '+str(original_mode)
 assert b'Goodbye!' in output, 'Quit did not use the existing CLI exit handler'
finally:
 if child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try: child.wait(timeout=2)
  except subprocess.TimeoutExpired:
   os.killpg(child.pid,signal.SIGKILL)
   child.wait()
 os.close(master)
 os.close(slave)
`;
    try {
      const result = spawnSync('python3', ['-c', python, mode, process.execPath,
        path.join(root, 'src/terminal/main.mjs'), ...(startupResume ? ['--resume', 'command-fixture'] : [])], {
        cwd: project, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, BAHULAM_HOME: home, B0_TOKEN: '', KEPLER_TOKEN: '',
          BAHULAM_TUI: 'rust', TARANG_ENV: 'local', BAHULAM_TUI_MOUSE: '0',
          BAHULAM_TUI_BINARY: path.join(root, 'rust/target/debug/bahulam-tui'),
          BAHULAM_AUTO_ATTACH: '0', BAHULAM_NO_PREFLIGHT: '1', BAHULAM_SKIP_AUTO_REGISTER: 'true',
          BAHULAM_MODEL_CATALOG_OFFLINE: '1', BAHULAM_SKIP_UPGRADE_CHECK: 'true', BAHULAM_DISABLE_TELEMETRY: '1',
        },
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const after = fs.readFileSync(savedFile, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(after.filter(record => record.message), records,
        'commands must preserve original saved messages and append no model turns');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
