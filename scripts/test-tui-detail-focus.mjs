// Real Rust/Node PTY: details inspection must never trap the composer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') { console.log('SKIP: PTY requires Unix'); process.exit(0); }
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-detail-focus-'));
const driver = path.join(temp, 'driver.mjs');
fs.writeFileSync(driver, `
import fs from 'node:fs';
import { startRustTuiHost } from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs', import.meta.url).href)};
const prompts=[];
const host=startRustTuiHost({onCommand:command=>{
 if(command.type==='prompt') {
  prompts.push(command.data.text);fs.writeFileSync(process.argv[2]+".tmp",JSON.stringify(prompts));fs.renameSync(process.argv[2]+".tmp",process.argv[2]);
  const send=(seq,type,data)=>host.send({v:2,seq,ts:'',type,session_id:'focus',turn_id:'queue-test',agent_id:'main',data});
  if(command.data.text==='start queued fixture') send(10,'turn_started',{text:'start queued fixture'});
  if(command.data.text==='queued followup') setTimeout(()=>{
   send(11,'message_end',{text:'QUEUE_FINAL'});
   send(12,'turn_ended',{ok:true});
   send(13,'turn_started',{text:'queued followup'});
  },700);
 }

}});
host.send({v:2,seq:1,ts:'',type:'tool_finished',session_id:'focus',agent_id:'main',data:{tool_id:'fixture',preview:'one\\ntwo',output:'one\\ntwo\\nthree\\nfour'}});
host.send({v:2,seq:1,ts:'',type:'command_catalog',session_id:'focus',agent_id:'main',data:{commands:[{name:'/resume',description:'history'},{name:'/report',description:'report'}]}});
setTimeout(()=>host.close(),20000).unref();
`);
const python = String.raw`
import os,pty,fcntl,termios,struct,subprocess,select,time,signal,sys,json
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
screen=Screen(36,120)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',36,120,0,0))
child=subprocess.Popen(sys.argv[3:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
def pump(seconds=.12):
 end=time.monotonic()+seconds
 while time.monotonic()<end and child.poll() is None:
  if select.select([master],[],[],.01)[0]:
   data=os.read(master,65536);screen.feed(data)
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
def wait(text):
 end=time.monotonic()+3
 while text not in screen.text() and time.monotonic()<end:pump(.03)
 assert text in screen.text(),'Missing '+text+'\n'+screen.text()
def send(keys):os.write(master,keys);pump()
def click(label,offset=0):
 wait(label)
 row,line=next((i,line) for i,line in enumerate(screen.text().splitlines()) if label in line)
 col=line.index(label)+4
 send(('\x1b[<0;%d;%dM\x1b[<0;%d;%dm'%(col,row+offset+1,col,row+offset+1)).encode())
expected=[]
def submit(text,keys):
 expected.append(text);send(keys+b'\r')
 end=time.monotonic()+3
 actual=[]
 while time.monotonic()<end:
  if os.path.exists(sys.argv[2]):
   with open(sys.argv[2]) as f:actual=json.load(f)
   if actual==expected:return
  pump(.03)
 raise Exception('Prompt handoff mismatch: '+repr((actual,expected))+'\n'+screen.text())
try:
 wait('Show details')
 send(b'/re');wait('/resume');send(b'\x1b[B');wait('/report');submit('/report',b'')
 submit('/resume saved-id',b'/resume saved-id')
 large='界 line\n'*24
 send(b'\x1b[200~'+large.encode()+b'\x1b[201~');wait('Pasted 25 lines')
 submit(large,b'')
 send(b'\x1b[200~'+large.encode()+b'\x1b[201~');wait('Pasted 25 lines');send(b'\x0f')
 submit(large,b'')
 send(b'draft')
 click('Show details');wait('Show less')
 click('Message',1)
 submit('click draft',b'\x1b[Hclick \x1b[F')
 click('Show less');wait('Show details')
 submit('after click',b'after click')
 click('Show details');send(b'\x1b');wait('Show details')
 submit('after escape',b'after escape')
 click('Show details');wait('Show less')
 submit('typed while open',b'typed while open')
 click('Show less');click('Show details');wait('Show less')
 submit('paste while open',b'\x1b[200~paste while open\x1b[201~')
 click('Show less');send(b'\t\r');wait('Show less')
 send(b'\r');wait('Show details')
 submit('after keyboard',b'after keyboard')
 send(b'\t\x1b\r');wait('Details')
 send(b'\x1b');wait('Show details')
 submit('after separate details',b'after separate details')
 submit('start queued fixture',b'start queued fixture')
 submit('queued followup',b'queued followup');wait('1 queued')
 wait('QUEUE_FINAL');pump(.2)
 assert '1 queued' not in screen.text(),screen.text()
 assert screen.text().index('QUEUE_FINAL') < screen.text().rindex('queued followup'),screen.text()
 send(b'\x03\x03')
 child.wait(timeout=3)
 assert child.returncode==0
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=2)
 os.close(master);os.close(slave)
`;
try {
 for (const mode of ['inline','fullscreen']) {
  const resultFile=path.join(temp,mode+'.json');
  const result=spawnSync('python3',['-c',python,path.join(root,'scripts'),resultFile,process.execPath,driver,resultFile],{
   encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024,
   env:{...process.env,BAHULAM_HOME:temp,BAHULAM_TUI_MODE:mode,BAHULAM_TUI_MOUSE:'1',BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui')},
  });
  assert.equal(result.status,0,`${mode}: ${result.stdout}\n${result.stderr}`);
 }
 console.log('PASS: composer click, Show less, Esc, keyboard collapse, direct typing and paste all preserve prompt handoff in both views.');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
