// Fake OS helpers: exercise Rust integrations without real clipboard/apps/notifications.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if (process.platform==='win32') { console.log('SKIP: Unix PTY fixture'); process.exit(0); }
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bahulam-integrations-'));
const driver=path.join(temp,'driver.mjs');
const source=path.join(temp,'source with spaces.rs');fs.writeFileSync(source,'// fixture');
const body='Open '+source+'\n```rust\nlet value = "界";\n```\n';
for (const helper of ['open','xdg-open','pbcopy','wl-copy']) fs.writeFileSync(path.join(temp,helper),`#!/usr/bin/env python3
import os,sys,json
home=os.environ['BAHULAM_HOME']
if os.path.basename(sys.argv[0]) in ('pbcopy','wl-copy'):open(os.path.join(home,'copied'),'w').write(sys.stdin.read())
else:json.dump(sys.argv[1:],open(os.path.join(home,'opened'),'w'))
`,{mode:0o700});
fs.writeFileSync(driver,`
import fs from 'node:fs';
import {startRustTuiHost} from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs',import.meta.url).href)};
const host=startRustTuiHost({onCommand:c=>{
 if(c.type==='prompt' && c.data.text==='/trigger')host.send({v:2,seq:3,ts:'',type:'approval_required',session_id:'os',agent_id:'main',data:{apr_id:'os-approval',name:'fixture_tool',args:{value:'fixture'},reason:'fixture approval',available_scopes:['once']}});
 if(c.type==='deny')host.send({v:2,seq:4,ts:'',type:'approval_decided',session_id:'os',agent_id:'main',data:{apr_id:'os-approval',decision:'deny'}});
}});
host.send({v:2,seq:1,ts:'',type:'session_started',session_id:'os',agent_id:'main',data:{cwd:${JSON.stringify(temp)}}});
host.send({v:2,seq:2,ts:'',type:'message_end',session_id:'os',agent_id:'main',data:{text:${JSON.stringify(body)}}});
setTimeout(()=>host.close(),15000).unref();
`);
const python=String.raw`
import os,sys,pty,fcntl,termios,struct,subprocess,select,time,signal,json
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
screen=Screen(36,120);output=bytearray()
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',36,120,0,0))
child=subprocess.Popen(sys.argv[2:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
def pump(seconds=.15):
 end=time.monotonic()+seconds
 while time.monotonic()<end and child.poll() is None:
  if select.select([master],[],[],.01)[0]:
   data=os.read(master,65536);output.extend(data);screen.feed(data)
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
def wait(predicate):
 end=time.monotonic()+4
 while not predicate() and time.monotonic()<end:pump(.03)
 assert predicate(),screen.text()+'\n'+repr(bytes(output[-500:]))
def send(data):os.write(master,data);pump()
home=os.environ['BAHULAM_HOME'];copied=os.path.join(home,'copied')
try:
 wait(lambda:'let value' in screen.text())
 send(b'/copy code\r');wait(lambda:os.path.exists(copied) and open(copied).read()=='let value = "界";\n')
 os.unlink(copied);send(b'/copy\r');wait(lambda:'Copy conversation content' in screen.text());send(b'\r')
 wait(lambda:os.path.exists(copied) and 'Open ' in open(copied).read());pump(.3)
 send(b'\x1bl');wait(lambda:b'\x1b]8;;file://' in output)
 send(b'\x1bo');wait(lambda:os.path.exists(os.path.join(home,'opened')))
 assert json.load(open(os.path.join(home,'opened')))==[os.path.join(home,'source with spaces.rs')]
 send(b'/trigger\r');wait(lambda:'Permission needed' in screen.text())
 send(b'\x1b[O');wait(lambda:b'\x1b]9;Bahulam approval:' in output)
 count=output.count(b'\x1b]9;Bahulam approval:');pump(.3);assert output.count(b'\x1b]9;Bahulam approval:')==count==1
 send(b'\x1b[I2');wait(lambda:'Permission needed' not in screen.text())
 send(b'\x03\x03');child.wait(timeout=3);assert child.returncode==0
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=3)
 os.close(master);os.close(slave)
`;
try {
 for(const mode of ['inline','fullscreen']){
  for(const name of ['copied','opened'])fs.rmSync(path.join(temp,name),{force:true});
  const result=spawnSync('python3',['-c',python,path.join(root,'scripts'),process.execPath,driver],{encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,env:{...process.env,BAHULAM_HOME:temp,PATH:temp+path.delimiter+process.env.PATH,BAHULAM_TUI_MODE:mode,BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui'),BAHULAM_CLIPBOARD:'native',BAHULAM_TUI_FILE_OPENER:'system',BAHULAM_TUI_CAPABILITIES:JSON.stringify({focus_reporting:true,synchronized_output:true,osc8_links:true,notifications:'osc9',keyboard_protocol:false,osc7_cwd:false,osc133_shell_marks:false})}});
  assert.equal(result.status,0,`${mode}: ${result.stdout}\n${result.stderr}`);
 }
 console.log('PASS: both views copy code/full replies, open literal file paths, emit OSC8 links and notify once for an unfocused approval using fake OS helpers.');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
