// Real Rust PTY + Node host; deterministic workers, no model/tool execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') { console.log('SKIP: agent PTY requires Unix'); process.exit(0); }
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-agents-'));
const driver = path.join(temp, 'driver.mjs');
fs.writeFileSync(driver, `
import fs from 'node:fs';
import {startRustTuiHost} from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs', import.meta.url).href)};
let seq=0; const history=[]; const file=process.argv[2];
const send=(type,agent,data,remember=true)=>{const e={v:2,seq:++seq,ts:'',type,session_id:'agents',turn_id:'turn1',agent_id:agent,parent_agent_id:agent==='main'?null:'main',data};if(remember)history.push(e);host.send(e);};
const host=startRustTuiHost({onCommand:c=>{
 if(c.type==='prompt')fs.writeFileSync(file+'.prompt',c.data.text);
 if(c.type==='approve'||c.type==='deny') {
  fs.writeFileSync(file+'.approval',JSON.stringify(c));
  send('approval_decided','worker3',{apr_id:'apr3',decision:c.type==='approve'?'allow':'deny'});
 }
}});
send('turn_started','main',{text:'Coordinate workers'});
send('message_end','main',{text:Array.from({length:60},(_,i)=>'MAIN-'+String(i).padStart(3,'0')).join('\\n')});
for(let n=1;n<=5;n++) {
 const id='worker'+n;
 send('agent_spawned',id,{type:'Worker '+n,task:'Task '+n});
 send('message_end',id,{text:'PRIVATE-'+n+'\\nWorker investigation '+n});
 send('tool_requested',id,{tool_id:'shared',name:'read_file',args:{path:'worker-'+n+'.rs'}});
 send('tool_started',id,{tool_id:'shared'});
 send('agent_status',id,{status:'working',tokens:{total:n*1200},elapsed_ms:2000,cost_usd:0.01});
}
setInterval(()=>{
 if(!fs.existsSync(file+'.control'))return;
 const action=fs.readFileSync(file+'.control','utf8');fs.unlinkSync(file+'.control');
 if(action==='approval')send('approval_required','worker3',{apr_id:'apr3',name:'shell',args:{command:'fixture-check'},reason:'Worker verification',scopes:['once','deny']});
 if(action==='finish') for(const n of [4,2,5,1,3]) {
  const id='worker'+n;
  send('tool_finished',id,{tool_id:'shared',ok:n!==4,output:'result '+n});
  send('agent_finished',id,{ok:n!==4,report:Array.from({length:8},(_,i)=>'REPORT-'+n+'-'+i).join('\\n'),error:n===4?'Fixture failure':'',tokens:{total:n*2000},elapsed_ms:4000});
 }
 if(action==='resume')send('transcript_snapshot','main',{replace:true,mode:'full',items:history.map(event=>({kind:'event',event}))},false);
},30).unref();
setTimeout(()=>host.close(),30000).unref();
`);
const python = String.raw`
import os,sys,pty,fcntl,termios,struct,subprocess,select,time,signal,re,json
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
screen=Screen(40,120)
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
child=subprocess.Popen(sys.argv[3:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
file=sys.argv[2]
def pump(seconds=.15):
 end=time.monotonic()+seconds
 while time.monotonic()<end and child.poll() is None:
  if select.select([master],[],[],.01)[0]:
   data=os.read(master,65536);screen.feed(data)
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
def wait(predicate):
 end=time.monotonic()+4
 while not predicate() and time.monotonic()<end:pump(.04)
 assert predicate(),screen.text()
def send(keys):os.write(master,keys);pump(.2)
def control(action):
 with open(file+'.control','w') as f:f.write(action)
 pump(.25)
def coords(label):
 row,line=next((i,line) for i,line in enumerate(screen.text().splitlines()) if label in line)
 return line.index(label)+2,row+1
def click(label):
 x,y=coords(label)
 send(('\x1b[<0;%d;%dM\x1b[<0;%d;%dm'%(x,y,x,y)).encode())
def first_main():
 matches=re.findall(r'MAIN-\d+',screen.text());return matches[0] if matches else None
def resize(rows,cols):
 global screen
 screen=Screen(rows,cols)
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0));os.killpg(child.pid,signal.SIGWINCH);pump(.4)
try:
 wait(lambda:'Worker 5' in screen.text() and 'Running read_file' in screen.text())
 assert 'PRIVATE-' not in screen.text(),screen.text()
 send(b'\x1ba')
 send(b'\x1b[200~draft\x1b[201~');wait(lambda:'draft' in screen.text())
 send(b'\t\x1b[H');wait(lambda:'MAIN-000' in screen.text())
 anchor=first_main()
 click('Worker 2');wait(lambda:'PRIVATE-2' in screen.text())
 assert 'PRIVATE-1' not in screen.text() and 'MAIN-' not in screen.text()
 resize(24,65);wait(lambda:'PRIVATE-2' in screen.text())
 resize(40,120);send(b'\x1b');wait(lambda:first_main()==anchor)
 assert 'draft' in screen.text()
 # Keyboard navigation selects the next worker; Esc restores the same main anchor.
 send(b'\x1ba\x1b[B\r');wait(lambda:'PRIVATE-3' in screen.text())
 control('approval');wait(lambda:'Permission needed' in screen.text())
 assert 'worker3' in screen.text() and 'fixture-check' in screen.text(),screen.text()
 send(b'\x1baIGNORED');assert 'IGNORED' not in screen.text()
 send(b'1');wait(lambda:os.path.exists(file+'.approval'))
 answer=json.load(open(file+'.approval'))
 assert answer['type']=='approve' and answer['data']['apr_id']=='apr3',answer
 send(b'\x1b');wait(lambda:first_main()==anchor)
 send(b' kept\r');wait(lambda:os.path.exists(file+'.prompt'))
 assert open(file+'.prompt').read()=='draft kept'
 control('finish');send(b'\t\x1b[F')
 wait(lambda:'REPORT-3-7' in screen.text())
 assert 'Show details' not in screen.text(),'Reports must remain full messages'
 # Completed workers remain inspectable, including failure and final line.
 send(b'\x1ba\x1b[B\r');wait(lambda:'REPORT-4-7' in screen.text())
 assert 'Fixture failure' in screen.text() and 'Last tool: read_file' in screen.text()
 send(b'\x1b')
 control('resume');wait(lambda:'Transcript loaded' in screen.text() or 'REPORT-3-7' in screen.text())
 pump(.3);assert 'Permission needed' not in screen.text(),'Historical approval became actionable'
 send(b'\x1ba');wait(lambda:'saved done' in screen.text() and 'saved failed' in screen.text())
 click('Worker 2');wait(lambda:'REPORT-2-7' in screen.text())
 assert 'REPORT-3-' not in screen.text()
 send(b'\x1b');send(b'after resume\r');wait(lambda:open(file+'.prompt').read()=='after resume')
 pasted='\n'.join('pasted line %d'%n for n in range(1000))
 send(b'\x1ba');send(b'\x1b[200~'+pasted.encode()+b'\x1b[201~')
 wait(lambda:'Pasted 1000 lines' in screen.text())
 send(b'\r');wait(lambda:open(file+'.prompt').read()==pasted)
 send(b'\x03\x03');child.wait(timeout=3);assert child.returncode==0
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=2)
 os.close(master);os.close(slave)
`;
try {
 for (const mode of ['inline', 'fullscreen']) {
  const file = path.join(temp, mode);
  const result = spawnSync('python3', ['-c', python, path.join(root, 'scripts'), file, process.execPath, driver, file], {
   encoding: 'utf8', timeout: 35000, maxBuffer: 2*1024*1024,
   env: {...process.env, TERM:'xterm-256color', BAHULAM_HOME:temp, BAHULAM_TUI_MODE:mode, BAHULAM_TUI_MOUSE:'1', BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui')},
  });
  assert.equal(result.status,0,`${mode}: ${result.stdout}\n${result.stderr}`);
 }
 console.log('PASS: five workers in both Rust views; click/keyboard inspection, resize, return anchor/draft, approval identity, full success/failure reports and resumed history.');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
