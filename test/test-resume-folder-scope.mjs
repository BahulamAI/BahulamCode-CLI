import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resume-folder-')));
const originalCwd = process.cwd();
process.env.BAHULAM_HOME = home;
const { transcriptProjectSlug } = await import('../src/core/paths.mjs');
const { getRecentSessions } = await import('../src/core/local-store.mjs');
const { listResumableSessions } = await import('../src/terminal/repl-resume.mjs');
const current = path.join(home, 'work', 'team-a', 'repo');
const collision = path.join(home, 'work', 'team', 'a-repo');
const other = path.join(home, 'work', 'other', 'repo');
const child = path.join(current, 'child');
const empty = path.join(home, 'empty');
for (const cwd of [current, collision, other, child, empty]) fs.mkdirSync(cwd, {recursive:true});
assert.equal(transcriptProjectSlug(current), transcriptProjectSlug(collision));
const message = (uuid, role, content, parentUuid) => ({uuid, parentUuid, type:role,
  timestamp:'2026-11-17T00:00:00Z',message:{role,content}});
const write = (cwd, id, rows) => {
  const dir = path.join(home, 'projects', transcriptProjectSlug(cwd));
  fs.mkdirSync(dir, {recursive:true});
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, rows.map(row => JSON.stringify({cwd,sessionId:id,...row})).join('\n')+'\n');
  return file;
};
const complete = id => [message(id+'-u','user','question'),message(id+'-a','assistant','answer')];
const kept = write(current, 'here', complete('here'));
const colliding = write(collision, 'wrong-collision', complete('collision'));
write(other, 'wrong-same-name', complete('other'));
write(child, 'wrong-child', complete('child'));
write(current, 'split-local', [message('split-user','user','split question')]);
write(current, 'split-backend', [message('split-answer','assistant','split reply','split-user')]);
// A newer colliding slug must not consume a scoped result limit.
fs.utimesSync(colliding, new Date('2030-01-01'), new Date('2030-01-01'));
const before = fs.readFileSync(kept,'utf8');
const originalReadStream = fs.createReadStream;
const forbidden = [other,child].map(cwd => path.join(home,'projects',transcriptProjectSlug(cwd))+path.sep);
fs.createReadStream = function(file, ...args) {
  assert.ok(!forbidden.some(prefix => String(file).startsWith(prefix)), 'Scoped picker read an unrelated project transcript');
  return originalReadStream.call(this,file,...args);
};
syncBuiltinESMExports();
try {
  const scoped = await getRecentSessions(Infinity,{projectPath:current});
  assert.deepEqual(scoped.map(s=>s.sessionId).sort(), ['here','split-local']);
  assert.ok(scoped.every(s=>s.project===current));
  assert.deepEqual(scoped.find(s=>s.sessionId==='split-local').linkedSessionIds,['split-backend']);
  assert.equal((await getRecentSessions(1,{projectPath:current})).length,1);
  assert.deepEqual(await getRecentSessions(Infinity,{projectPath:current,sessionIdPrefix:'wrong'}),[]);
  assert.deepEqual((await getRecentSessions(Infinity,{projectPath:current+path.sep})).map(s=>s.sessionId).sort(),['here','split-local']);
  process.chdir(current);
  assert.deepEqual((await listResumableSessions()).map(s=>s.sessionId).sort(),['here','split-local']);
  assert.deepEqual(await listResumableSessions('wrong'),[]);
  process.chdir(empty);
  assert.deepEqual(await listResumableSessions(),[], 'Empty folder must not fall back to global sessions');
  assert.equal(fs.readFileSync(kept,'utf8'),before,'Listing rewrote a transcript');
  console.log('PASS: resume lists only current-folder sessions, excludes child/same-name/colliding folders before unrelated reads, retains linked history, respects limits and never falls back globally.');
} finally {
  fs.createReadStream = originalReadStream;
  syncBuiltinESMExports();
  process.chdir(originalCwd);
  fs.rmSync(home,{recursive:true,force:true});
}
