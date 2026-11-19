// Real renderer, large synthetic history, no model calls. --measure permits baseline idle writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') { console.log('SKIP: PTY requires Unix'); process.exit(0); }
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-idle-'));
const driver = path.join(temp, 'driver.mjs');
fs.writeFileSync(driver, `
import { startRustTuiHost } from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs', import.meta.url).href)};
const host = startRustTuiHost({mode:'fullscreen',onCommand: command => {
  if (command.type === 'prompt') {
    // Control frames can reuse seq; they still need an immediate redraw.
    host.send({v:2,seq:1,ts:'',type:'interaction_requested',session_id:'idle',agent_id:'main',data:{
      request_id:'test',title:'CONTROL_FRAME_VISIBLE',options:[{label:'Cancel',value:'cancel'}]
    }});
  }
}});
host.send({v:2,seq:1,ts:'',type:'transcript_snapshot',session_id:'idle',agent_id:'main',data:{
 replace:true,mode:'full',items:Array.from({length:1000},(_,i)=>({kind:'history',role:'assistant',
 content:'MESSAGE_'+i+'\\n'+Array.from({length:30},(_,j)=>'Result '+j+' with **formatting** and ` + '`code`' + `').join('\\n')+'\\nTAIL_'+i}))
}});
setTimeout(()=>host.close(),10000).unref();
`);
const python = String.raw`
import errno,fcntl,json,os,pty,resource,select,signal,struct,subprocess,sys,termios,time
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
screen=Screen(40,140)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
child=subprocess.Popen(sys.argv[2:],stdin=slave,stdout=slave,stderr=slave,close_fds=True,start_new_session=True)
def read_for(seconds,until=None):
 end=time.monotonic()+seconds
 count=0
 while time.monotonic()<end:
  if select.select([master],[],[],0.01)[0]:
   try: chunk=os.read(master,65536)
   except OSError as e:
    if e.errno==errno.EIO: break
    raise
   count+=len(chunk)
   screen.feed(chunk)
   if b'\x1b[6n' in chunk: os.write(master,b'\x1b[1;1R')
  if until and until in screen.text(): return count
 if until: raise Exception('Missing '+until+'\n'+screen.text())
 return count
try:
 read_for(5,'TAIL_999')
 read_for(0.3)
 idle_bytes=read_for(2)
 sent=time.monotonic()
 os.write(master,b'\x1b[5~')
 read_for(5,'MESSAGE_999')
 scroll_ms=round((time.monotonic()-sent)*1000,1)
 sent=time.monotonic()
 os.write(master,b'\x1b[5~')
 read_for(2,'MESSAGE_998')
 warm_scroll_ms=round((time.monotonic()-sent)*1000,1)
 sent=time.monotonic()
 os.write(master,b'/help\r')
 read_for(2,'CONTROL_FRAME_VISIBLE')
 response_ms=round((time.monotonic()-sent)*1000,1)
 os.write(master,b'\x03\x03')
 end=time.monotonic()+3
 while child.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],0.01)[0]: os.read(master,65536)
 child.wait(timeout=2)
 assert child.returncode==0
 usage=resource.getrusage(resource.RUSAGE_CHILDREN)
 print(json.dumps(dict(idle_bytes=idle_bytes,response_ms=response_ms,scroll_ms=scroll_ms,warm_scroll_ms=warm_scroll_ms,cpu_seconds=round(usage.ru_utime+usage.ru_stime,3))))
finally:
 if child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  child.wait(timeout=2)
 os.close(master)
 os.close(slave)
`;
try {
  const result = spawnSync('python3', ['-c', python, path.join(root, 'scripts'), process.execPath, driver], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, BAHULAM_HOME: temp, BAHULAM_TUI_BINARY: path.join(root, 'rust/target/debug/bahulam-tui') },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const metrics = JSON.parse(result.stdout);
  console.log(JSON.stringify(metrics));
  if (!process.argv.includes('--measure')) assert.equal(metrics.idle_bytes, 0, 'Idle renderer kept repainting');
  assert.ok(metrics.response_ms < 1000, 'Control event redraw was delayed');
} finally { fs.rmSync(temp, {recursive:true,force:true}); }
