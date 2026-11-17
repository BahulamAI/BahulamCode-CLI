// Real normal-screen renderer: tall/short layouts, banner scroll-away and draft preservation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') { console.log('SKIP: PTY requires Unix'); process.exit(0); }
const root = fileURLToPath(new URL('../',import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'bahulam-inline-layout-'));
const driver = path.join(temp,'driver.mjs');
fs.writeFileSync(driver, `
import { startRustTuiHost } from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs',import.meta.url).href)};
process.stdout.write('BAHULAM STARTUP HEADER\\nWelcome to this session\\n');
const host=startRustTuiHost({mode:'inline'});
host.send({v:2,seq:1,ts:'',type:'transcript_snapshot',session_id:'layout',agent_id:'main',data:{replace:true,mode:'full',items:[
 {kind:'history',role:'assistant',content:Array.from({length:80},(_,i)=>'LINE_'+String(i+1).padStart(3,'0')).join('\\n')}
]}});
setTimeout(()=>host.close(),15000).unref();
`);
const python=String.raw`
import os,pty,fcntl,termios,struct,subprocess,select,time,signal,sys,re
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
rows,cols=40,120
screen=Screen(rows,cols)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
child=subprocess.Popen(sys.argv[2:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
output=bytearray()
def pump(until):
 end=time.monotonic()+3
 while time.monotonic()<end:
  if select.select([master],[],[],0.01)[0]:
   chunk=os.read(master,65536);output.extend(chunk);screen.feed(chunk)
  if until(screen.text()): return
 raise Exception('Layout did not settle; child='+str(child.poll())+'\n'+screen.text()+'\nRAW '+repr(bytes(output[-500:])))
def check(draft=False):
 lines=screen.text().splitlines()
 assert 'Message' in lines[rows-5], 'Composer is not at the bottom'
 assert ('draft kept' if draft else 'Ask Bahulam') in lines[rows-4], 'Input row misplaced'
 assert 'Ctrl+C twice quit' in lines[-1], 'Footer not on final row'
 assert 'BAHULAM STARTUP HEADER' not in screen.text(), 'Startup header remained pinned'
 assert 'Rust inline' not in screen.text(), 'Brand heading remained in composer'
 assert b'\x1b[?1049h' not in output, 'Inline entered alternate screen'
def resize(r,c,marker):
 global rows,cols,screen
 rows,cols=r,c
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
 screen=Screen(rows,cols)
 os.killpg(child.pid,signal.SIGWINCH)
 pump(lambda text: marker in text and 'Ctrl+C twice quit' in text)
 check(True)
try:
 pump(lambda text:'LINE_080' in text and 'Ctrl+C twice quit' in text)
 check()
 assert len(re.findall('LINE_\\d+',screen.text()))>25, 'History still limited to a small viewport'
 os.write(master,b'draft kept')
 pump(lambda text:'draft kept' in text)
 resize(56,150,'LINE_080')
 assert len(re.findall('LINE_\\d+',screen.text()))>40, 'History did not grow with height'
 for i in range(85):
  if 'LINE_001' in screen.text():break
  os.write(master,b'\x1b[<64;10;4M')
  start=time.monotonic()
  pump(lambda text: time.monotonic()-start>0.03)
 pump(lambda text:'LINE_001' in text)
 resize(20,60,'LINE_001')
 for i in range(85):
  if 'LINE_080' in screen.text():break
  os.write(master,b'\x1b[<65;10;4M')
  start=time.monotonic()
  pump(lambda text: time.monotonic()-start>0.03)
 pump(lambda text:'LINE_080' in text)
 check(True)
 resize(36,100,'LINE_080')
 os.write(master,b'\x03\x03')
 end=time.monotonic()+3
 while child.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],0.01)[0]:os.read(master,65536)
 assert child.poll()==0, "Exit status: "+str(child.poll())
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=2)
 os.close(master);os.close(slave)
`;
try {
 const result=spawnSync('python3',['-c',python,path.join(root,'scripts'),process.execPath,driver],{
  encoding:'utf8',timeout:18000,maxBuffer:2*1024*1024,
  env:{...process.env,BAHULAM_HOME:temp,BAHULAM_TUI_MOUSE:'1',BAHULAM_TUI_SCROLL_LINES:'1',BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui')},
 });
 assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
 console.log('PASS: inline fills 120x40, 150x56, 60x20 and 100x36; header scrolls away, composer stays at bottom, history and draft survive.');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
