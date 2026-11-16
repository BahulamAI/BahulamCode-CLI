// Compiled Rust + real Node host, with fixture sessions and no model/backend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('SKIP: popup PTY check requires Unix');
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = path.join(root, 'rust/target/debug/bahulam-tui');
assert.ok(fs.existsSync(binary), 'Run npm run tui:build first');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-resume-popup-'));
const resultFile = path.join(temp, 'responses.json');
const driver = path.join(temp, 'driver.mjs');
fs.writeFileSync(driver, `
import fs from 'node:fs';
import { startRustTuiHost } from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs', import.meta.url).href)};
const responses = [];
let picker = 0;
let host;
const send = (type, data) => host.send({v:2,seq:1,ts:'',type,session_id:'popup-fixture',agent_id:'main',data});
host = startRustTuiHost({mode:'fullscreen',onCommand: async command => {
  if (command.type === 'prompt' && command.data.text === '/resume') {
    picker++;
    await send('interaction_requested', {request_id:'resume-'+picker,title:'Resume a session',
      message:'Choose a saved transcript.',options:Array.from({length:30},(_,i)=>({
        label:'S'+String(i).padStart(2,'0')+' · project · '+('long saved instruction '.repeat(12)),value:'saved-'+i
      }))});
  } else if (command.type === 'interaction_response') {
    responses.push(command.data);
    fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(responses));
    if (!command.data.cancelled) await send('transcript_snapshot', {replace:true,mode:'full',items:[
      {kind:'history',role:'user',content:'Saved question'},
      {kind:'history',role:'assistant',content:'SAVED_REPLY_RESTORED'}
    ]});
  } else if (command.type === 'prompt') {
    responses.push(command.data);
    fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(responses));
  }
}});
setTimeout(()=>host.close(),12000).unref();
`);
const python = String.raw`
import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
def resize(rows, cols):
 fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
resize(24, 100)
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, close_fds=True, start_new_session=True)
os.close(slave)
output, stage_output = bytearray(), bytearray()
stage, started, stage_at = 0, time.time(), time.time()
try:
 while child.poll() is None and time.time()-started < 10:
  if select.select([master], [], [], 0.02)[0]:
   try:
    chunk = os.read(master, 65536)
    output.extend(chunk)
    stage_output.extend(chunk)
    if b'\x1b[6n' in chunk: os.write(master,b'\x1b[1;1R')
   except OSError as error:
    if error.errno != errno.EIO: raise
  screen = re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]',b'',bytes(stage_output))
  screen = re.sub(rb'\s+',b'',screen)
  keys = None
  if stage == 0 and b'AskBahulam' in screen: keys = b'/resume\r'
  elif stage == 1 and b'Resumeasession' in screen: keys = b'\x1b[B'*29
  elif stage == 2 and time.time()-stage_at > 0.3:
   resize(16,40)
   os.killpg(child.pid,signal.SIGWINCH)
   stage_output.clear()
   stage, stage_at = 3, time.time()
  elif stage == 3 and b'S29' in screen: keys = b'\r'
  elif stage == 4:
   # Confirm must send the last session, then restore the saved reply at normal size.
   resize(24,100)
   os.killpg(child.pid,signal.SIGWINCH)
   stage_output.clear()
   stage, stage_at = 5, time.time()
  elif stage == 5 and b'SAVED_REPLY_RESTORED' in screen: keys = b'/resume\r'
  elif stage == 6 and b'Resumeasession' in screen: keys = b'\x1b'
  elif stage == 7 and time.time()-stage_at > 0.2: keys = b'after cancel\r'
  elif stage == 8 and os.path.exists(sys.argv[1]):
   with open(sys.argv[1]) as result: responses = json.load(result)
   if len(responses) == 3: keys = b'\x03\x03'
  if keys is not None:
   stage += 1
   stage_at = time.time()
   stage_output.clear()
   os.write(master,keys)
 if stage != 9 or child.poll() is None or child.returncode != 0:
  raise Exception('Popup PTY failed at stage '+str(stage)+'\n'+output[-12000:].decode('utf8','replace'))
finally:
 if child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try: child.wait(timeout=2)
  except subprocess.TimeoutExpired:
   os.killpg(child.pid,signal.SIGKILL)
   child.wait()
 os.close(master)
`;
try {
  const result = spawnSync('python3', ['-c', python, resultFile, process.execPath, driver], {
    encoding: 'utf8', timeout: 16000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, BAHULAM_HOME: temp, BAHULAM_TUI_BINARY: binary },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), [
    { request_id: 'resume-1', value: 'saved-29', cancelled: false },
    { request_id: 'resume-2', value: null, cancelled: true },
    { text: 'after cancel' },
  ]);
  console.log('PASS: resume popup selects the last of 30 sessions across resize, restores the reply, cancels, and returns input ownership.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
