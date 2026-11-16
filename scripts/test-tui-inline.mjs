// Real Rust client and Node host; synthetic conversation, no backend/model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') { console.log('SKIP: inline PTY test requires Unix'); process.exit(0); }
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-inline-'));
const driver = path.join(temp, 'driver.mjs');
const resultFile = path.join(temp, 'commands.json');
fs.writeFileSync(driver, `
import fs from 'node:fs';
import { startRustTuiHost } from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs', import.meta.url).href)};
const commands = [];
const host = startRustTuiHost({ onCommand: command => {
  commands.push(command);
  fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(commands));
}});
host.send({v:2,seq:1,ts:'',type:'transcript_snapshot',session_id:'inline-test',agent_id:'main',data:{
  replace:true,mode:'full',items:[{kind:'event',event:{type:'command_result',data:{name:'/fixture',result:Array.from({length:200},(_,i)=>'REPLY_'+String(i+1).padStart(3,'0')).join('\\n')}}}]
}});
setTimeout(()=>host.close(),15000).unref();
`);
const python = String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time
sys.dont_write_bytecode=True
sys.path.insert(0, ${JSON.stringify(path.join(root, 'scripts'))})
from tui_test_screen import Screen
screen=Screen(32,110)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,110,0,0))
original=termios.tcgetattr(slave)
child=subprocess.Popen(sys.argv[2:],stdin=slave,stdout=slave,stderr=slave,close_fds=True,start_new_session=True)
output=bytearray()
stage=0
resized=False
deadline=time.time()+12
try:
 while child.poll() is None and time.time()<deadline:
  if select.select([master],[],[],0.02)[0]:
   chunk=os.read(master,65536)
   output.extend(chunk)
   screen.feed(chunk)
   if b'\x1b[6n' in chunk: os.write(master,b'\x1b[1;1R')
  text=screen.text()
  keys=None
  if stage==0 and 'Rust inline' in text and 'REPLY_001' in text and 'Show details' in text:
   assert b'\x1b[?1049h' not in output, 'Inline unexpectedly used alternate screen'
   assert 'Show details' in text and 'REPLY_007' not in text, 'Reply was not folded'
   keys=b'draft kept\t\r'
  elif stage==1 and 'Details' in text: keys=b'\x1b[F'
  elif stage==2 and 'REPLY_200' in text: keys=b'\x1b'
  elif stage==3 and 'Show details' in text and 'draft kept' in text:
   if not resized:
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
    screen=Screen(24,80)
    os.killpg(child.pid,signal.SIGWINCH)
    resized=True
   else: keys=b'\t' + b'\x7f'*10 + b'/tui fullscreen\r'
  elif stage==4 and 'Agents' in text and b'\x1b[?1049h' in output:
   assert 'REPLY_001' in text and 'Show details' in text
   keys=b'/tui inline\r'
  elif stage==5 and 'Rust inline' in text and output.count(b'\x1b[?1049l')==1:
   assert 'REPLY_001' in text and 'Show details' in text
   keys=b'after switch\r'
  elif stage==6 and os.path.exists(sys.argv[1]):
   with open(sys.argv[1]) as f: commands=json.load(f)
   if any(c.get('data',{}).get('text')=='after switch' for c in commands): keys=b'\x03\x03'
  if keys is not None:
   stage+=1
   os.write(master,keys)
 if child.poll()!=0 or stage!=7: raise Exception('Inline flow failed at '+str(stage)+'\n'+screen.text())
 while select.select([master],[],[],0.02)[0]: output.extend(os.read(master,65536))
 assert b'[done] Assistant' not in output, 'Inline exit duplicated the transcript'
 restored=termios.tcgetattr(slave)
 pending=getattr(termios,'PENDIN',0)
 restored[3]&=~pending
 original[3]&=~pending
 assert restored==original, 'Inline did not restore terminal settings'
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
  const result = spawnSync('python3', ['-c', python, resultFile, process.execPath, driver], {
    encoding: 'utf8', timeout: 18000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, BAHULAM_HOME: temp, BAHULAM_TUI_MODE: '', BAHULAM_TUI_BINARY: path.join(root, 'rust/target/debug/bahulam-tui') },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const commands = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.deepEqual(commands.filter(command => command.type === 'prompt').map(command => command.data.text), ['after switch']);
  console.log('PASS: inline command preview, complete details, draft restoration, fullscreen round trip, shared prompt handoff and clean exit.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
