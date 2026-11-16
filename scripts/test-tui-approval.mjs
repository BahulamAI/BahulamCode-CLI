// Real Rust input + Node policy/approval bridge. No tools execute or model calls occur.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') { console.log('SKIP: PTY requires Unix'); process.exit(0); }
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'bahulam-approval-'));
const driver = path.join(temp,'driver.mjs');
const resultFile = path.join(temp,'result.json');
fs.writeFileSync(driver, `
import fs from 'node:fs';
import { startRustTuiHost } from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs',import.meta.url).href)};
import { ApprovalManager } from ${JSON.stringify(new URL('../src/core/approval.mjs',import.meta.url).href)};
import { createRustApprovalBridge } from ${JSON.stringify(new URL('../src/daemon/rust-approval.mjs',import.meta.url).href)};
let seq=0;
let host;
const results=[];
const send=(type,data,extra={})=>host.send({v:2,seq:++seq,ts:'',type,session_id:'approval-test',agent_id:'main',data,...extra});
const bridge=createRustApprovalBridge({emit:send});
const manager=new ApprovalManager({cwd:'/fixture',policy:{hitl:{allowSessionTrust:true}},
 trustStore:{find:()=>null,add:()=>({id:'test',pattern:'fixture'})},approvalLog:{append:()=>{}},getPromptHandler:()=>bridge.choose});
host=startRustTuiHost({onCommand:async command=>{
 if(command.type==='approve'||command.type==='deny') bridge.answer(command.type,command.data);
 if(command.type==='show_details') send('detail_loaded',{payload_ref:command.data.payload_ref,detail:Array.from({length:12},(_,i)=>'HYDRATED_'+String(i+1).padStart(3,'0')).join('\\n')});
}});
// Core confirmations must not compete with the Rust terminal owner.
process.stderr.write=(_chunk,_encoding,callback)=>{if(typeof callback==='function')callback();return true;};
results.push(await manager.check('bahulam_info',{query:'where are you located?',topic:'runtime'},true));
results.push(await manager.check('unknown_info',{query:'fixture request'},true,{reason:'Fixture permission check'}));
results.push(await manager.check('shell',{command:'custom-cli inspect'},true,{reason:'Fixture shell approval'}));
fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(results));
send('message_end',{}, {payload_ref:'memory:fixture-reply'});
setTimeout(()=>host.close(),10000).unref();
`);
const python=String.raw`
import os,pty,fcntl,termios,struct,subprocess,select,time,signal,sys,json
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
screen=Screen(32,110)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,110,0,0))
child=subprocess.Popen(sys.argv[3:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
stage=0
end=time.monotonic()+10
try:
 while child.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],0.01)[0]:
   chunk=os.read(master,65536);screen.feed(chunk)
   if b'\x1b[6n' in chunk:os.write(master,b'\x1b[1;1R')
  text=screen.text()
  if stage==0 and 'Permission needed' in text and 'unknown_info' in text and '[3]' in text:
   assert '/fixture' in text and 'Fixture permission check' in text
   os.write(master,b'3');stage=1
  elif stage==1 and 'Permission needed' in text and 'custom-cli inspect' in text:
   assert 'shell' in text and '[2] deny' in text
   os.write(master,b'2');stage=2
  elif stage==2 and 'HYDRATED_012' in text:
   assert 'Show details' not in text,'Assistant still folded behind details'
   os.write(master,b'\t\r');stage=3;entered=time.monotonic()
  elif stage==3 and time.monotonic()-entered>0.15:
   assert 'Details ·' not in text,'Enter opened assistant details'
   os.write(master,b'\x03\x03');stage=4
 if child.poll()!=0 or stage!=4:raise Exception('Approval flow stage '+str(stage)+'\n'+screen.text())
 with open(sys.argv[2]) as f:results=json.load(f)
 assert results[0]['approved'] and results[1]['approved'] and not results[2]['approved'],results
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=2)
 os.close(master);os.close(slave)
`;
try {
 for (const mode of ['inline','fullscreen']) {
  const result=spawnSync('python3',['-c',python,path.join(root,'scripts'),resultFile,process.execPath,driver],{
   encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,
   env:{...process.env,BAHULAM_HOME:temp,BAHULAM_TUI_MODE:mode,BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui')},
  });
  assert.equal(result.status,0,`${mode}: ${result.stdout}\n${result.stderr}`);
 }
 console.log('PASS: both views use Node policy, scoped approval/deny controls, and automatic full assistant reply hydration.');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
