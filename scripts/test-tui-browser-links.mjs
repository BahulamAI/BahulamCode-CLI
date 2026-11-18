// Real Rust clicks/keyboard with a fake browser: never launch an external app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') process.exit(0);
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bahulam-browser-'));
const driver=path.join(temp,'driver.mjs');
for(const name of ['open','xdg-open']) fs.writeFileSync(path.join(temp,name),`#!/usr/bin/env python3
import os,sys,json
target=os.path.join(os.environ['BAHULAM_HOME'],'opened')
with open(target+'.tmp','w') as f:json.dump(sys.argv[1:],f)
os.replace(target+'.tmp',target)
`,{mode:0o700});
fs.writeFileSync(driver,`
import fs from 'node:fs';
import {startRustTuiHost} from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs',import.meta.url).href)};
const host=startRustTuiHost({onCommand:c=>{if(c.type==='prompt') {
 fs.writeFileSync(process.argv[2]+'.tmp',c.data.text);fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);
}}});
host.send({v:2,seq:1,ts:'',type:'message_end',session_id:'links',agent_id:'main',data:{text:'Browser fixture\\n[Docs](https://example.test/wiki_(page))\\nhttps://other.test/a?x=1&y=2'}});
setTimeout(()=>host.close(),20000).unref();
`);
const python=String.raw`
import os,sys,pty,fcntl,termios,struct,subprocess,select,time,signal,json
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
screen=Screen(36,120);output=bytearray()
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',36,120,0,0))
child=subprocess.Popen(sys.argv[3:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
opened=os.path.join(os.environ['BAHULAM_HOME'],'opened')
def pump(seconds=.15):
 end=time.monotonic()+seconds
 while time.monotonic()<end and child.poll() is None:
  if select.select([master],[],[],.01)[0]:
   data=os.read(master,65536);output.extend(data);screen.feed(data)
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
def wait(predicate):
 end=time.monotonic()+3
 while not predicate() and time.monotonic()<end:pump(.03)
 assert predicate(),screen.text()
def send(keys):os.write(master,keys);pump()
def coords(label):
 row,line=next((i,line) for i,line in enumerate(screen.text().splitlines()) if label in line)
 return line.index(label)+3,row+1
def mouse(code,x,y,end='M'):send(('\x1b[<%d;%d;%d%s'%(code,x,y,end)).encode())
def check_open(uri):
 wait(lambda:os.path.exists(opened))
 assert json.load(open(opened))==[uri],open(opened).read()
 os.unlink(opened);pump(.25)
try:
 wait(lambda:'Open 2' in screen.text());send(b'draft')
 enabled=json.loads(os.environ['BAHULAM_TUI_CAPABILITIES'])['osc8_links']
 assert (b'\x1b]8;;https://' in output)==enabled
 x,y=coords('Open 2')
 mouse(0,x,y);mouse(32,x+2,y);mouse(0,x+2,y,'m');assert not os.path.exists(opened)
 mouse(0,x,y);mouse(0,1,1,'m');assert not os.path.exists(opened)
 mouse(0,x,y);mouse(0,x,y,'m');check_open('https://other.test/a?x=1&y=2')
 # A modal owns input; clicking an old browser row cannot open it.
 send(b'\x1bl');wait(lambda:'Open a browser link' in screen.text())
 mouse(0,x,y);mouse(0,x,y,'m');assert not os.path.exists(opened)
 send(b'\x1b');wait(lambda:'Open a browser link' not in screen.text())
 send(b'\x1bl');wait(lambda:'Open a browser link' in screen.text());send(b'\x1b[B\r')
 check_open('https://other.test/a?x=1&y=2')
 # Geometry is recomputed after narrowing, including wrapped original prose.
 screen=Screen(36,70)
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',36,70,0,0));os.killpg(child.pid,signal.SIGWINCH)
 wait(lambda:'Open 1' in screen.text())
 x,y=coords('Open 1');mouse(0,x,y);mouse(0,x,y,'m');check_open('https://example.test/wiki_(page)')
 send(b' kept\r');wait(lambda:os.path.exists(sys.argv[2]))
 assert open(sys.argv[2]).read()=='draft kept',screen.text()
 send(b'\x03\x03');child.wait(timeout=3);assert child.returncode==0
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=2)
 os.close(master);os.close(slave)
`;
try {
 for(const mode of ['inline','fullscreen']) for(const osc8 of [false,true]) {
  const resultFile=path.join(temp,mode+osc8);
  const result=spawnSync('python3',['-c',python,path.join(root,'scripts'),resultFile,process.execPath,driver,resultFile],{
   encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024,
   env:{...process.env,PATH:temp+path.delimiter+process.env.PATH,BAHULAM_HOME:temp,BAHULAM_TUI_MODE:mode,BAHULAM_TUI_MOUSE:'1',BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui'),BAHULAM_TUI_CAPABILITIES:JSON.stringify({osc8_links:osc8,keyboard_protocol:false})},
  });
  assert.equal(result.status,0,`${mode}, OSC8 ${osc8}: ${result.stdout}\n${result.stderr}`);
 }
 console.log('PASS: browser click, drag isolation, modal ownership, Alt+L selection, resize and draft handoff in both Rust views with/without OSC8.');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
