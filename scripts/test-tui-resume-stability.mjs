// Real CLI, isolated copies only. Optional --session ID checks a local transcript
// without modifying it or sending a prompt/model request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-resume-stability-')));
const home = path.join(temp, 'home');
const project = path.join(temp, 'project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'package.json'), '{"name":"resume-fixture"}');
const sid = process.argv[2] === '--session' ? process.argv[3] : 'resume-stability';
const sourceHome = process.env.BAHULAM_HOME || path.join(os.homedir(), '.bahulam');
const sourceStore = await import('../src/core/local-store.mjs');
const dir = path.join(home, 'projects', project.replaceAll('/', '-'));
fs.mkdirSync(dir, { recursive: true });
if (process.argv[2] === '--session') {
  const source = await sourceStore.getSessionDetail(sid);
  assert.ok(source, 'Source transcript must exist');
  for (const id of [sid, ...(source.linkedSessionIds || [])]) {
    const d = await sourceStore.getSessionDetail(id);
    const records = fs.readFileSync(d.filePath, 'utf8').trim().split('\n').map(JSON.parse);
    for (const record of records) record.cwd = project;
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), records.map(JSON.stringify).join('\n') + '\n');
    const durable = path.join(sourceHome, 'sessions', id);
    if (fs.existsSync(durable)) fs.cpSync(durable, path.join(home, 'sessions', id), { recursive: true });
  }
} else {
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [
    { type: 'user', message: { role: 'user', content: 'STABILITY_QUESTION' } },
    { type: 'assistant', message: { role: 'assistant', content: 'STABILITY_ANSWER' } },
  ].map((r, i) => JSON.stringify({ ...r, sessionId: sid, cwd: project, timestamp: `2026-11-16T00:00:0${i}Z` })).join('\n') + '\n');
}
process.env.BAHULAM_HOME = home;
const store = await import(`../src/core/local-store.mjs?stability=${Date.now()}`);
const before = await store.getSessionDetail(sid);
const beforeHistory = store.buildResumeHistory(before, 'full').agentHistory;
const python = String.raw`
import os,pty,fcntl,termios,struct,subprocess,select,time,signal,sys,re,json
sys.dont_write_bytecode=True
sys.path.insert(0,${JSON.stringify(path.join(root, 'scripts'))})
from tui_test_screen import Screen
screen=Screen(40,150)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,150,0,0))
child=subprocess.Popen(sys.argv[2:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
received=bytearray()
def pump(seconds):
 end=time.time()+seconds
 while time.time()<end and child.poll() is None:
  if select.select([master],[],[],0.02)[0]:
   data=os.read(master,65536);screen.feed(data);received.extend(data)
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
def wait_for(text):
 end=time.time()+12
 while text not in screen.text().replace(' ','') and time.time()<end:pump(.05)
 assert text in screen.text().replace(' ',''),'Missing UI marker '+text+'; exit='+str(child.poll())+'; controls='+repr([line.strip() for line in screen.text().splitlines() if any(word in line.lower() for word in ['switch','directory','choose','resume','permission','approval','enter','error','cancel'])])
def command(value):
 for char in (value+'\r').encode():
  os.write(master,bytes([char]));pump(.04)
report=[]
try:
 wait_for('AskBahulam')
 for view in ['inline','fullscreen','default','inline','fullscreen']:
  command('/tui '+view);pump(1.0)
  command('/resume '+sys.argv[1]);pump(1.8)
  # Open the actual picker and capture only its context counters, not private messages.
  received.clear()
  command('/resume');pump(1.0)
  deadline=time.time()+6
  counters=[]
  while not counters and time.time()<deadline:
   pump(.1)
   plain=re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]','',received.decode('utf8','replace'))
   counters=re.findall(r'([\d.]+[kM]?)\s+ctx',plain)
  assert counters,'No context estimate shown in '+view+'; controls='+repr([line.strip() for line in screen.text().splitlines() if any(word in line.lower() for word in ['resume','enter','cancel','view'])])
  report.append({'view':view,'picker_context':counters})
  os.write(master,b'\x1b');pump(.4)
 os.write(master,b'\x03');pump(.15);os.write(master,b'\x03')
 end=time.time()+5
 while child.poll() is None and time.time()<end:pump(.05)
 assert child.poll()==0,'CLI did not exit cleanly'
 print(json.dumps(report))
finally:
 if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=3)
 os.close(master);os.close(slave)
`;
try {
  const result = spawnSync('python3', ['-c', python, sid, process.execPath, path.join(root, 'src/terminal/main.mjs'), '--resume', sid], {
    cwd: project, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    env: { ...process.env, BAHULAM_HOME: home, BAHULAM_TUI: 'rust', BAHULAM_TUI_MODE: 'inline', TARANG_ENV: 'local',
      BAHULAM_TUI_BINARY: path.join(root, 'rust/target/debug/bahulam-tui'), BAHULAM_TUI_MOUSE: '0',
      BAHULAM_AUTO_ATTACH: '0', BAHULAM_NO_PREFLIGHT: '1', BAHULAM_SKIP_AUTO_REGISTER: 'true',
      BAHULAM_MODEL_CATALOG_OFFLINE: '1', BAHULAM_SKIP_UPGRADE_CHECK: 'true', BAHULAM_DISABLE_TELEMETRY: '1' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const after = await store.getSessionDetail(sid);
  assert.deepEqual(store.buildResumeHistory(after, 'full').agentHistory, beforeHistory);
  assert.equal(after.meta.contextTokens, before.meta.contextTokens);
  console.log(result.stdout.trim());
  console.log(`PASS: repeated resumes across all three views preserve context (${after.meta.contextTokens} estimated transcript tokens) and canonical messages.`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
