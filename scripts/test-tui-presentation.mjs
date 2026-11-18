// Commands render fully; native text selection releases capture and pauses paints.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if (process.platform === 'win32') process.exit(0);
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bahulam-presentation-'));
const driver=path.join(temp,'driver.mjs');
fs.writeFileSync(driver,`
import fs from 'node:fs';
import {startRustTuiHost} from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs',import.meta.url).href)};
let seq=1;
const send=(type,data,extra={})=>host.send({v:2,seq:seq++,ts:'',type,session_id:'presentation',agent_id:'main',data,...extra});
const host=startRustTuiHost({onCommand:c=>{
 if(c.type==='show_details') send('detail_loaded',{payload_ref:c.data.payload_ref,detail:'Status first\\nStatus second\\nStatus third\\nSTATUS_FINAL'});
 if(c.type==='prompt') {
  fs.writeFileSync(process.argv[2]+'.tmp',c.data.text);fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);
  if(c.data.text==='/stream') setTimeout(()=>send('message_end',{text:'STREAM_AFTER_SELECTION'}),600);
 }
}});
send('command_result',{name:'/status',result:'short preview'},{payload_ref:'memory:status'});
send('tool_finished',{tool_id:'short',preview:'TOOL_FIRST\\nTOOL_SECOND',output:'TOOL_FIRST\\nTOOL_SECOND'});
setTimeout(()=>host.close(),15000).unref();
`);
const python=String.raw`
import os,sys,pty,fcntl,termios,struct,subprocess,select,time,signal
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
screen=Screen(36,120);output=bytearray()
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',36,120,0,0))
child=subprocess.Popen(sys.argv[3:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
def pump(seconds=.12):
 end=time.monotonic()+seconds
 while time.monotonic()<end and child.poll() is None:
  if select.select([master],[],[],.01)[0]:
   data=os.read(master,65536);output.extend(data);screen.feed(data)
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
def wait(text):
 end=time.monotonic()+3
 while text not in screen.text() and time.monotonic()<end:pump(.03)
 assert text in screen.text(),text+'\n'+screen.text()
def send(data):os.write(master,data);pump()
try:
 wait('STATUS_FINAL');wait('TOOL_SECOND')
 assert 'Show details' not in screen.text(),screen.text()
 send(b'/stream\r');send(b'draft')
 before=len(output);send(b'\x1bm');wait('Text selection')
 assert b'\x1b[?1000l' in output[before:],'Native mouse reporting not disabled'
 before=len(output);pump(.8)
 assert len(output)==before,'Streaming repainted during native selection'
 assert 'STREAM_AFTER_SELECTION' not in screen.text()
 before=len(output);send(b'\x1bm');wait('STREAM_AFTER_SELECTION')
 assert b'\x1b[?1000h' in output[before:],'Mouse controls were not restored'
 assert 'draft' in screen.text()
 # Typing also exits selection mode without swallowing the character.
 send(b'\x1bm');wait('Text selection');send(b' kept\r');pump(.2)
 assert open(sys.argv[2]).read()=='draft kept',screen.text()
 assert 'Text selection' not in screen.text()
 send(b'\x03\x03');child.wait(timeout=3);assert child.returncode==0
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=2)
 os.close(master);os.close(slave)
`;
try {
 for(const mode of ['inline','fullscreen']) {
  const resultFile=path.join(temp,mode);
  const result=spawnSync('python3',['-c',python,path.join(root,'scripts'),resultFile,process.execPath,driver,resultFile],{
   encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,
   env:{...process.env,BAHULAM_HOME:temp,BAHULAM_TUI_MODE:mode,BAHULAM_TUI_MOUSE:'1',BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui')},
  });
  assert.equal(result.status,0,`${mode}: ${result.stdout}\n${result.stderr}`);
 }
 console.log('PASS: full command hydration, two-line tool preview, mouse capture release/restore, paused paints and draft handoff in both Rust views.');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
