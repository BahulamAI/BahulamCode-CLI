// Real input reader/renderer under a PTY with simulated terminal replies. No agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') { console.log('SKIP: active probes use the Unix input backend'); process.exit(0); }
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-probes-'));
const driver = path.join(temp, 'driver.mjs');
fs.writeFileSync(driver, `
import fs from 'node:fs';
import { startRustTuiHost } from ${JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs', import.meta.url).href)};
let host;
const commands=[];
function start() {
 host=startRustTuiHost({onCommand:c=>{
   commands.push(c); fs.writeFileSync(process.argv[2]+'.tmp',JSON.stringify(commands));
   fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);
 },onExit:()=>{ if(process.env.PROBE_CASE==='cache' && commands.filter(c=>c.type==='hello').length===1) start(); }});
 host.send({v:2,seq:1,ts:'',type:'message_end',session_id:'probe',agent_id:'main',data:{text:'CAPABILITY_FIXTURE'}});
}
start();setTimeout(()=>host.close(),15000).unref();
`);
const python = String.raw`
import os,sys,pty,fcntl,termios,struct,subprocess,select,time,signal,json
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from tui_test_screen import Screen
screen=Screen(30,110); output=bytearray(); answered=0; query_at=None
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,110,0,0))
original=termios.tcgetattr(slave)
child=subprocess.Popen(sys.argv[3:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
case=os.environ['PROBE_CASE']
def commands():
 try:return json.load(open(sys.argv[2]))
 except FileNotFoundError:return []
def hellos():return [c['data']['capabilities'] for c in commands() if c['type']=='hello']
def pump(seconds=.03):
 global answered,query_at
 end=time.monotonic()+seconds
 while time.monotonic()<end and child.poll() is None:
  if select.select([master],[],[],.005)[0]:
   data=os.read(master,65536);output.extend(data);screen.feed(data)
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
   if output.count(b'\x1b[c') > answered:
    answered+=1;query_at=time.monotonic()
    if answered==2:
     os.write(master,b'\x1b]11;rgb:0000/0000/0000\x07\x1b[?64;1;4c')
     continue
    if case not in ('timeout','partial_osc','partial_csi','disabled','dumb','transport'):
     # Preserve a real draft, Unicode, arrows, and paste arriving among replies.
     os.write(master,'draft é'.encode()+b'\x1b[D!\x1b[C\x1b[200~ pasted\x1b[201~')
     if case=='positive':os.write(master,b'\x1b[200~ literal \x1b]11;rgb:0/0/0\x07\x1b[201~')
     positive=case in ('positive','cache')
     # Fragment a reply across reads; reply parsing must retain its prefix.
     os.write(master,b'\x1b[?2026;');time.sleep(.015)
     os.write(master,(b'2$y' if positive else b'0$y')+b'\x1b[?1004;2$y\x1b[?1006;2$y\x1b[?2004;2$y')
     # Malformed/oversized replies neither enter the composer nor enable modes.
     os.write(master,b'\x1b[?2026;9$y\x1b[?'+b'9'*2048+b'u')
     os.write(master,b'\x1b[6;20;10t\x1b[4;600;1100t')
     if positive:os.write(master,b'\x1b[?0u')
     if case in ('malformed','torn'):
      os.write(master,b'\x1b]11;rgb:zzzz/ffff/ffff\x07')
      os.write(master,b'\x1b]11;rgb:'+b'f'*4096+b'/f/f\x1b\\')
      if case=='torn':os.write(master,b'\x1b]11;rgb:ffff/ffff/ffff') # interrupted by DA1
     elif case!='background_off':
      reply=b'\x1b]11;rgb:ffff/ffff/ffff\x1b\\' if case!='theme_light' and case!='negative' else b'\x1b]11;rgb:0/0/0\x07'
      # Include the Escape/prefix/terminator boundaries in fragmentation coverage.
      for byte in reply:
       os.write(master,bytes([byte]));time.sleep(.0015)
     os.write(master,b'\x1b[?64;1;4c')
    elif case=='timeout':os.write(master,b'draft')
    elif case=='partial_osc':os.write(master,b'draft\x1b]11;rgb:ffff/')
    elif case=='partial_csi':os.write(master,b'draft\x1b[?2026;')
def wait(predicate):
 end=time.monotonic()+4
 while not predicate() and time.monotonic()<end:pump()
 assert predicate(),(case,screen.text(),commands())
try:
 wait(lambda:len(hellos())==1)
 caps=hellos()[0];probe=caps['probe'];features=caps['features']
 wait(lambda:'CAPABILITY_FIXTURE' in screen.text())
 if case in ('disabled','dumb','transport'):
  assert not answered,'Skipped probe wrote query escapes'
  assert probe['status'].startswith('skipped')
 else:
  assert probe['elapsed_ms']<=260,probe # 200 ms budget plus scheduling tolerance
  if case in ('timeout','partial_osc','partial_csi'):
   assert not probe['complete'] and probe['keyboard_protocol'] is None
   assert not features['keyboard_protocol']['enabled'] and not features['synchronized_output']['enabled']
   assert probe['elapsed_ms']>=180
   pump(.06) # an unfinished packet's own deadline is also bounded
   # Late responses are consumed as replies, never inserted into the draft.
   os.write(master,b'\x1b[?1u\x1b[?2026;2$y\x1b[?64;1c\x1b]11;rgb:f/f/f\x07');pump()
   assert caps['theme_source']!='OSC11 background reply'
   expected='draft'
  else:
   assert probe['complete'] and probe['cell_pixels']==[10,20],probe
   assert probe['sixel'] is True and probe['window_pixels']==[1100,600]
   assert probe['synchronized_output']==(case in ('positive','cache'))
   assert probe['keyboard_protocol']==(case in ('positive','cache'))
   assert features['focus_reporting']['detected'] is True
   assert features['focus_reporting']['source']=='override' and not features['focus_reporting']['enabled']
   expected='draft !é pasted'
   if case=='positive':expected+=' literal ]11;rgb:0/0/0' # composer strips control bytes, not pasted text
   if case=='background_off':
    assert b'\x1b]11;?' not in output and not probe['background_requested']
   elif case in ('malformed','torn'):
    assert probe['background_rgb'] is None and caps['theme_source']!='OSC11 background reply',caps
   else:
    assert probe['background_rgb']==([0,0,0] if case in ('negative','theme_light') else [255,255,255]),caps
    expected_theme='dark' if case in ('negative','theme_dark') else 'light'
    assert caps['theme']==expected_theme,caps
    assert caps['theme_source']==('explicit configuration' if case.startswith('theme_') else 'OSC11 background reply'),caps
  os.write(master,b'\r')
  wait(lambda:any(c['type']=='prompt' for c in commands()))
  assert next(c['data']['text'] for c in commands() if c['type']=='prompt')==expected,commands()
 if case=='positive':
  # A manual choice wins after detection and remains effective through view changes.
  os.write(master,b'/theme dark\r');wait(lambda:len(hellos())==2)
  assert hellos()[-1]['theme']=='dark' and hellos()[-1]['theme_source']=='explicit /theme command'
  other=b'/tui fullscreen\r' if os.environ['BAHULAM_TUI_MODE']=='inline' else b'/tui inline\r'
  os.write(master,other);wait(lambda:len(hellos())==3)
  assert hellos()[-1]['theme']=='dark'
 if case=='negative':
  other=b'/tui fullscreen\r' if os.environ['BAHULAM_TUI_MODE']=='inline' else b'/tui inline\r'
  os.write(master,other);wait(lambda:len(hellos())==2)
  assert not hellos()[1]['features']['keyboard_protocol']['enabled']
  assert b'\x1b[>1u' not in output and b'\x1b[?2026h' not in output,'View switch re-enabled unsupported modes'
 if case=='cache':
  os.write(master,b'\x03\x03');wait(lambda:len(hellos())==2)
  cached=hellos()[1]['probe'];assert 'cached modes' in cached['status'],cached
  assert cached['elapsed_ms']<=260 and cached['cell_pixels'] is None
  assert output.count(b'\x1b[?2026$p')==1,'Reattachment repeated stable mode queries'
  assert output.count(b'\x1b]11;?')==2,'Reattachment did not refresh the background'
  assert hellos()[0]['theme']=='light' and hellos()[1]['theme']=='dark'
 os.write(master,b'\x03\x03');wait(lambda:child.poll() is not None);assert child.returncode==0
 # Host and Rust cleanup must restore the pre-launch terminal settings.
 restored=termios.tcgetattr(slave);pending=getattr(termios,'PENDIN',0)
 restored[3]&=~pending;original[3]&=~pending
 assert original==restored,'Raw mode leaked after capability probing'
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=2)
 os.close(master);os.close(slave)
`;
try {
  for (const mode of ['inline', 'fullscreen']) for (const scenario of ['positive', 'negative', 'timeout', 'disabled', 'dumb', 'transport', 'cache', 'theme_dark', 'theme_light', 'background_off', 'malformed', 'torn', 'partial_osc', 'partial_csi']) {
    const resultFile = path.join(temp, `${mode}-${scenario}.json`);
    const result = spawnSync('python3', ['-c', python, path.join(root, 'scripts'), resultFile, process.execPath, driver, resultFile], {
      encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, TERM: scenario === 'dumb' ? 'dumb' : 'xterm-256color', TERM_PROGRAM: ['timeout', 'negative'].includes(scenario) ? 'ghostty' : 'test-terminal',
        TMUX: scenario === 'transport' ? 'test-multiplexer' : '', STY: '',
        BAHULAM_THEME: scenario === 'theme_dark' ? 'dark' : scenario === 'theme_light' ? 'light' : '',
        BAHULAM_HOME: temp, BAHULAM_TUI_MODE: mode, PROBE_CASE: scenario,
        BAHULAM_TUI_BINARY: path.join(root, 'rust/target/debug/bahulam-tui'),
        BAHULAM_TUI_CAPABILITIES: JSON.stringify({ focus_reporting: false, active_probes: scenario !== 'disabled', background_color: scenario !== 'background_off' }),
      },
    });
    assert.equal(result.status, 0, `${mode}/${scenario}: ${result.stdout}\n${result.stderr}`);
  }
  const doctor = spawnSync(path.join(root, 'rust/target/debug/bahulam-tui'), ['--doctor', '--json'], { encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(doctor.stdout.includes('\x1b'), false, 'Piped doctor must not send queries');
  assert.equal(JSON.parse(doctor.stdout).interactive, false);
  console.log('PASS: bounded probes, fragmented/late/malformed replies, input preservation, overrides, cache, fallback and cleanup in both Rust views.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
