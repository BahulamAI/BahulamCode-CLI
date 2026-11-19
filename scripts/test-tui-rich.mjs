import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.platform==='win32')process.exit(0);
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bahulam-rich-'));
const python=String.raw`
import os,sys,pty,fcntl,termios,struct,subprocess,select,time,signal
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
screen=Screen(100,120)
image_marker="▓" if os.environ.get("NO_COLOR") else "▀"
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',100,120,0,0))
child=subprocess.Popen(sys.argv[2:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
def pump(seconds=.15):
 end=time.monotonic()+seconds
 while time.monotonic()<end and child.poll() is None:
  if select.select([master],[],[],.01)[0]:
   data=os.read(master,65536);screen.feed(data)
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
def wait(predicate):
 end=time.monotonic()+5
 while not predicate() and time.monotonic()<end:pump(.03)
 assert predicate(),screen.text()
def send(data):os.write(master,data);pump(.2)
def resize(rows,cols):
 global screen
 screen=Screen(rows,cols);fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0));os.killpg(child.pid,signal.SIGWINCH);pump(.4)
try:
 wait(lambda:'Sequence preview' in screen.text() and 'Note over Agent, Tool: Read-only' in screen.text() and '┃' in screen.text() and 'loop Retry' in screen.text())
 assert 'Note over Agent, Tool: Read-only' in screen.text(),screen.text()
 assert '┃' in screen.text(),screen.text()
 assert 'alt Cached' in screen.text() and 'else Fetch' in screen.text() and 'loop Retry' in screen.text(),screen.text()
 send(b'draft kept\t\x1b[H')
 wait(lambda:image_marker in screen.text())
 assert 'Read pages 1 of 1' in screen.text(),screen.text()
 assert 'Loading image preview' not in screen.text()
 resize(24,60);send(b'\x1b[H')
 for _ in range(18):
  if image_marker in screen.text():break
  send(b'\x1b[B')
 wait(lambda:image_marker in screen.text())
 assert 'draft kept' in screen.text()
 send(b'\x1b[F');wait(lambda:'Reply delivered' in screen.text())
 assert image_marker not in screen.text(),'Image cells survived scrolling out of view'
 resize(100,120);send(b'\x1b[H');wait(lambda:image_marker in screen.text())
 send(b'\x1b');send(b'\r');send(b'\t\x1b[F');wait(lambda:'Demo received: draft kept' in screen.text())
 send(b'\x03\x03');child.wait(timeout=3);assert child.returncode==0
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=2)
 os.close(master);os.close(slave)
`;
try {
 for(const mode of ['inline','fullscreen']) for(const monochrome of [false,true]) {
  const r=spawnSync('python3',['-c',python,path.join(root,'scripts'),process.execPath,path.join(root,'scripts/tui-rich-demo.mjs')],{
   encoding:'utf8',timeout:25000,env:{...process.env,NO_COLOR:monochrome?'1':'',FORCE_COLOR:monochrome?'0':'1',TERM:'xterm-256color',BAHULAM_HOME:temp,BAHULAM_TUI_MODE:mode,BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui')},
  });assert.equal(r.status,0,`${mode}, monochrome=${monochrome}: ${r.stdout}\n${r.stderr}`);
 }
 console.log('PASS: image, document, flowchart and sequence together in both Rust views; narrow/tall resize, scroll cleanup and preserved draft.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
