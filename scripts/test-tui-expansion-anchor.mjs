// Expanding below the top row must not scroll the conversation or lose a draft.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') process.exit(0);
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-anchor-'));
const driver = path.join(temp, 'driver.mjs');
fs.writeFileSync(driver, `
import fs from 'node:fs';
import {startRustTuiHost} from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs', import.meta.url).href)};
const host=startRustTuiHost({onCommand:c=>{if(c.type==='prompt') {
 fs.writeFileSync(process.argv[2]+'.tmp',c.data.text);fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);
}}});
for(let i=0;i<12;i++) host.send({v:2,seq:i+1,ts:'',type:'tool_finished',session_id:'anchor',agent_id:'main',data:{tool_id:'fixture-'+i,preview:'MARKER_'+i+'_0\\nMARKER_'+i+'_1',output:Array.from({length:7},(_,j)=>'MARKER_'+i+'_'+j).join('\\n')}});
setTimeout(()=>host.close(),20000).unref();
`);
const python = String.raw`
import os,pty,fcntl,termios,struct,subprocess,select,time,signal,sys,re
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
screen=Screen(36,120)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',36,120,0,0))
child=subprocess.Popen(sys.argv[3:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
def pump(seconds=.15):
 end=time.monotonic()+seconds
 while time.monotonic()<end and child.poll() is None:
  if select.select([master],[],[],.01)[0]:
   data=os.read(master,65536);screen.feed(data)
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
def wait(text):
 end=time.monotonic()+3
 while text not in screen.text() and time.monotonic()<end:pump(.03)
 assert text in screen.text(),text+'\n'+screen.text()
def send(keys):os.write(master,keys);pump()
def click(label,index=0):
 rows=[(i,line) for i,line in enumerate(screen.text().splitlines()) if label in line]
 row,line=rows[index];col=line.index(label)+3
 send(('\x1b[<0;%d;%dM\x1b[<0;%d;%dm'%(col,row+1,col,row+1)).encode())
def anchor():
 for row,line in enumerate(screen.text().splitlines()):
  match=re.search(r'MARKER_\d+_\d+',line)
  if match:return row,match[0]
 raise Exception(screen.text())
def check(before):
 assert before==anchor(),repr((before,anchor()))+'\n'+screen.text()
try:
 wait('Show details');send(b'draft')
 for scrolled in (False,True):
  if scrolled:send(b'\x1b[<64;12;8M'*3)
  before=anchor();click('Show details',1);wait('Show less');check(before)
  click('Show less');wait('Show details');check(before)
  click('Show details',1);wait('Show less');check(before)
  send(b'\x1b');wait('Show details');check(before)
 # The focused tool was retained; keyboard expansion uses the same anchor.
 before=anchor();send(b'\t\r');wait('Show less');check(before)
 send(b'\x1b');wait('Show details');check(before)
 send(b' kept\r');pump(.3)
 assert open(sys.argv[2]).read()=='draft kept',screen.text()
 send(b'\x03\x03');child.wait(timeout=3);assert child.returncode==0
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=2)
 os.close(master);os.close(slave)
`;
try {
 for (const mode of ['inline', 'fullscreen']) {
  const resultFile = path.join(temp, mode);
  const result = spawnSync('python3', ['-c', python, path.join(root,'scripts'), resultFile, process.execPath, driver, resultFile], {
   encoding:'utf8', timeout:25000, maxBuffer:2*1024*1024,
   env:{...process.env,BAHULAM_HOME:temp,BAHULAM_TUI_MODE:mode,BAHULAM_TUI_MOUSE:'1',BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui')},
  });
  assert.equal(result.status,0,`${mode}: ${result.stdout}\n${result.stderr}`);
 }
 console.log('PASS: mouse/keyboard expand, collapse and Esc preserve viewport row and editable draft in both Rust views.');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
