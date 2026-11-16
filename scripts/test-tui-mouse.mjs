// Exercise mouse capture, history navigation, draft focus and restoration in a PTY.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('SKIP: mouse PTY check requires Unix');
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = path.join(root, 'rust/target/debug/bahulam-tui');
assert.ok(fs.existsSync(binary), 'Run npm run tui:build first');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-mouse-'));
const driver = path.join(temp, 'driver.mjs');
fs.writeFileSync(driver, `
import fs from 'node:fs';
import { startRustTuiHost } from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs', import.meta.url).href)};
const host = startRustTuiHost({mode: process.env.BAHULAM_TUI_MODE, onCommand: command => {
  if (command.type === 'prompt') fs.writeFileSync(process.argv[2], JSON.stringify(command.data));
}});
const send = (seq,type,agent_id,data) => host.send({v:2,seq,ts:'',type,session_id:'mouse-test',agent_id,data});
await send(1,'transcript_snapshot','main',{replace:true,mode:'full',items:Array.from({length:30},(_,i)=>({
  kind:'history',role:'assistant',content:'HISTORY_'+String(i).padStart(2,'0')
}))});
await send(1,'session_started','main',{cwd:'/fixture',model:'fixture'});
await send(2,'agent_spawned','reviewer',{type:'reviewer',task:'Fixture review'});
await send(3,'message_end','reviewer',{text:'AGENT_DETAILS'});
setTimeout(()=>host.close(),12000).unref();
`);
const python = String.raw`
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
sys.dont_write_bytecode=True
sys.path.insert(0,${JSON.stringify(path.join(root, 'scripts'))})
from tui_test_screen import Screen
terminal_screen=Screen(24,100)
enabled = sys.argv[1] == '1'
master, slave = pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
original_mode = termios.tcgetattr(slave)
child = subprocess.Popen(sys.argv[3:],stdin=slave,stdout=slave,stderr=slave,close_fds=True,start_new_session=True)
output = bytearray()
stage_output = bytearray()
def pump(seconds):
 deadline = time.time()+seconds
 while time.time()<deadline:
  if select.select([master],[],[],0.02)[0]:
   chunk=os.read(master,65536)
   terminal_screen.feed(chunk)
   output.extend(chunk)
   stage_output.extend(chunk)
   if b'\x1b[6n' in chunk: os.write(master,b'\x1b[1;1R')
def screen():
 return re.sub(rb'\s+',b'',re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]',b'',bytes(stage_output)))
def wait_text(text):
 deadline=time.time()+3
 while text not in screen() and time.time()<deadline: pump(0.03)
 assert text in screen(), 'Missing '+str(text)+'\n'+screen()[-4000:].decode('utf8','replace')
def refresh(columns):
 global terminal_screen
 terminal_screen=Screen(24,columns)
 stage_output.clear()
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,columns,0,0))
 os.killpg(child.pid,signal.SIGWINCH)
try:
 wait_text(b'AskBahulam')
 os.write(master,b'draft kept')
 pump(0.2)
 if enabled:
  before={match.group():row for row,line in enumerate(terminal_screen.text().splitlines()) for match in re.finditer(r'HISTORY_\d+',line)}
  # Initial session card is included in the main transcript count.
  os.write(master,b'\x1b[<64;10;4M')
  pump(0.2)
  after={match.group():row for row,line in enumerate(terminal_screen.text().splitlines()) for match in re.finditer(r'HISTORY_\d+',line)}
  common=set(before)&set(after)
  assert common,'No common visible history row for scroll calibration'
  step=int(os.environ.get('BAHULAM_TUI_SCROLL_LINES','1'))
  assert all(after[key]-before[key]==step for key in common),(before,after,step)
  refresh(99)
  wait_text(b'HISTORY_27' if step>=3 else b'HISTORY_28')
  os.write(master,b'\x1b[<65;10;4M')
  pump(0.2)
  refresh(100)
  wait_text(b'HISTORY_29')
  os.write(master,b'\x1b[<64;10;4M'*150)
  pump(.5)
  refresh(99)
  wait_text(b'HISTORY_00')
  os.write(master,b'\x1b[<65;10;4M'*150)
  pump(.5)
  refresh(100)
  wait_text(b'HISTORY_29')
 os.write(master,b'\r')
 deadline=time.time()+3
 while not os.path.exists(sys.argv[2]) and time.time()<deadline: pump(0.03)
 with open(sys.argv[2]) as result: assert json.load(result)=={'text':'draft kept'}
 if enabled and os.environ.get('BAHULAM_TUI_MODE') != 'inline':
  os.write(master,b'\x1b[<65;90;4M')
  pump(0.2)
  os.write(master,b'\r')
  pump(0.2)
  refresh(99)
  wait_text(b'AGENT_DETAILS')
 os.write(master,b'\x03\x03')
 deadline=time.time()+3
 while child.poll() is None and time.time()<deadline: pump(0.03)
 pump(0.05)
 assert child.poll()==0, 'Client failed to exit cleanly'
 assert termios.tcgetattr(slave)==original_mode, 'Terminal mode not restored'
 assert (b'\x1b[?1000h' in output)==enabled, 'Capture must match the explicit setting'
 if enabled:
  assert b'\x1b[?1000l' in output and b'\x1b[?1006l' in output, 'Mouse reporting not disabled on exit'
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
  for (const mode of ['fullscreen', 'inline']) for (const setting of ['disabled', 'default', '3']) {
    const enabled = setting !== 'disabled';
    const resultFile = path.join(temp, `prompt-${mode}-${setting}.json`);
    const env = { ...process.env, BAHULAM_HOME: temp, BAHULAM_TUI_BINARY: binary, BAHULAM_TUI_MODE: mode };
    if (setting === '3') env.BAHULAM_TUI_SCROLL_LINES = '3';
    else delete env.BAHULAM_TUI_SCROLL_LINES;
    if (enabled) delete env.BAHULAM_TUI_MOUSE;
    else env.BAHULAM_TUI_MOUSE = '0';
    const result = spawnSync('python3', ['-c', python, enabled ? '1' : '0', resultFile,
      process.execPath, driver, resultFile], { env, encoding: 'utf8', timeout: 16000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `Mouse ${mode} ${setting}: ${result.stdout}\n${result.stderr}`);
  }
  console.log('PASS: both Rust views scroll exactly 1 line by default and 3 with the override; history/agent navigation preserves drafts and restores terminal modes.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
