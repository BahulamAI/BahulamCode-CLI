// Real Rust/Node PTY: agent questions use one input owner and preserve the draft.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') { console.log('SKIP: PTY requires Unix'); process.exit(0); }
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-questions-'));
const driver = path.join(temp, 'driver.mjs');
fs.writeFileSync(driver, `
import fs from 'node:fs';
import { startRustTuiHost } from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs', import.meta.url).href)};
import { createRustInteractions } from ${JSON.stringify(new URL('../src/daemon/rust-interactions.mjs', import.meta.url).href)};
import { askUserForm } from ${JSON.stringify(new URL('../src/terminal/repl-ask-form.mjs', import.meta.url).href)};
let bridge,started=false;const answers=[];let prompt=null;
const save=()=>fs.writeFileSync(process.argv[2],JSON.stringify({answers,prompt}));
const host=startRustTuiHost({onCommand:command=>{
 if(command.type==='hello'&&!started){started=true;setTimeout(run,300);}
 if(command.type==='interaction_response')bridge.answer(command.data);
 if(command.type==='interrupt')bridge.cancel();
 if(command.type==='prompt'){prompt=command.data.text;save();}
}});
bridge=createRustInteractions({send:event=>host.send(event),getSessionId:()=> 'question-fixture',timeoutMs:2500});
const ask=(question,options)=>askUserForm({question,options,choose:bridge.choose,rl:{pause(){throw Error('Node tried to take stdin');}}});
async function run(){
 const first=ask('CHOICE_ONE',['Yes','No']);
 const second=ask('FREE_ANSWER',[]);
 answers.push(await first,await second);
 answers.push(await ask('CANCEL_QUESTION',['Continue']));
 answers.push(await ask('TIMEOUT_QUESTION',['Continue']));save();
 host.send({v:2,seq:2,ts:'',type:'notice',session_id:'question-fixture',agent_id:'main',data:{level:'info',title:'QUESTIONS_DONE'}});
}
setTimeout(()=>{bridge.close();host.close();},15000).unref();
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
try:
 wait('Ask Bahulam');send(b'draft kept')
 wait('CHOICE_ONE');send(b'\x1b[B\r')
 wait('FREE_ANSWER');send(b'\r');wait('Your answer')
 send('\x1b[200~custom 界\x1b[201~'.encode());send(b'\x7f')
 send('\x1b[200~🌍\x1b[201~'.encode());send(b'\r')
 wait('CANCEL_QUESTION');send(b'\x1b')
 wait('TIMEOUT_QUESTION');wait('QUESTIONS_DONE')
 assert 'draft kept' in screen.text(),'Question lost the draft'
 send(b' after\r')
 end=time.monotonic()+3
 while time.monotonic()<end:
  if os.path.exists(sys.argv[2]):
   with open(sys.argv[2]) as f:result=json.load(f)
   if result['prompt'] is not None:break
  pump(.03)
 assert result=={'answers':[{'answer':'No','source':'option'},{'answer':'custom 🌍','source':'free_text'},None,None],'prompt':'draft kept after'},result
 send(b'\x03\x03');child.wait(timeout=3);assert child.returncode==0
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=2)
 os.close(master);os.close(slave)
`;
try {
 for (const mode of ['inline','fullscreen']) {
  const resultFile=path.join(temp,mode+'.json');
  const result=spawnSync('python3',['-c',python,path.join(root,'scripts'),resultFile,process.execPath,driver,resultFile],{
   encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,
   env:{...process.env,TERM:'xterm-256color',BAHULAM_HOME:temp,BAHULAM_TUI_MODE:mode,BAHULAM_TUI_MOUSE:'1',BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui')},
  });
  assert.equal(result.status,0,`${mode}: ${result.stdout}\n${result.stderr}`);
 }
 console.log('PASS: queued choices, Unicode free-text/paste, cancellation, timeout and preserved composer handoff in both Rust views.');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
