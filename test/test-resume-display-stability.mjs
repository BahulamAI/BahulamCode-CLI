import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-display-'));
process.env.BAHULAM_HOME = home;
const { getSessionDetail, buildResumeHistory, getRecentSessions } = await import('../src/core/local-store.mjs');
const { rustResumeItems } = await import('../src/daemon/rust-tui-snapshot.mjs');
const project = path.join(home, 'projects', 'fixture');
fs.mkdirSync(project, { recursive: true });
const write = (id, rows) => fs.writeFileSync(path.join(project, `${id}.jsonl`), rows.map(JSON.stringify).join('\n') + '\n');
const msg = (id, role, content, second) => ({ uuid: id, type: role, sessionId: 'local', timestamp: `2026-11-16T00:00:0${second}Z`, message: { role, content } });

test('linked split session reconstructs both halves without modifying files or inflating context on resume', async () => {
  write('local', [msg('u', 'user', 'question', 1)]);
  write('backend', [msg('a', 'assistant', 'answer', 2), { type: 'bahulam_event', timestamp: '2026-11-16T00:00:02Z', event: { type: 'content', data: { text: 'answer' } } }]);
  const events = path.join(home, 'sessions', 'local'); fs.mkdirSync(events, { recursive: true });
  fs.writeFileSync(path.join(events, 'events.jsonl'), JSON.stringify({ v:2, seq:1, ts:'2026-11-16T00:00:01Z', session_id:'local', type:'session_started', data:{session_id_from_backend:'backend'} })+'\n');
  const original = fs.readFileSync(path.join(project, 'backend.jsonl'), 'utf8');
  const initial = await getSessionDetail('local');
  assert.deepEqual(initial.linkedSessionIds, ['backend']);
  assert.equal((await getSessionDetail('backend')).meta.sessionId,'backend','filename must own picker identity even when early records have an old ID');
  assert.deepEqual((await getRecentSessions()).map(s=>s.sessionId),['local'],'linked fragments must not become duplicate picker choices');
  assert.deepEqual(buildResumeHistory(initial, 'full').agentHistory.map(m=>m.content), ['question','answer']);
  for (let i=0;i<5;i++) {
    fs.appendFileSync(path.join(project,'local.jsonl'), JSON.stringify({type:'bahulam_event',event:{type:'resume_context',data:{display:'not model context'.repeat(10000)}}})+'\n');
    const current=await getSessionDetail('local');
    assert.equal(current.meta.contextTokens,initial.meta.contextTokens);
    assert.deepEqual(buildResumeHistory(current,'full').agentHistory,buildResumeHistory(initial,'full').agentHistory);
  }
  assert.equal(fs.readFileSync(path.join(project,'backend.jsonl'),'utf8'),original);
});

test('Rust replay includes sparse saved replies, deduplicates prompts/streams and excludes prior resume commands', () => {
  const users=[{role:'user',content:'question',order:0}];
  const history=[...users,{role:'assistant',content:'first answer',order:2},{role:'assistant',content:'second answer',order:5}];
  const replay=[
    {order:0,event:{type:'turn_started',data:{text:'question'}}},
    {order:1,event:{type:'content_partial',data:{text:'first '}}},
    {order:2,event:{type:'content',data:{text:'first answer'}}},
    {order:3,event:{type:'tool_call',data:{call_id:'t',tool:'read_file',args:{path:'a'}}}},
    {order:6,event:{type:'command_result',data:{name:'/resume',output:'old replay'}}},
  ];
  const items=rustResumeItems(users,replay,history);
  assert.deepEqual(items.filter(i=>i.kind==='message').map(i=>i.content),['question','first answer','second answer']);
  assert.deepEqual(items.filter(i=>i.kind==='event').map(i=>i.event.type),['tool_call']);
});
process.on('exit',()=>fs.rmSync(home,{recursive:true,force:true}));

test('parentUuid recovers a split Node session without event logging and terminates cycles', async () => {
  write('parent', [msg('parent-user', 'user', 'node question', 1)]);
  write('child', [{...msg('child-reply', 'assistant', 'node answer', 2),parentUuid:'parent-user'},
    {type:'bahulam_event', event:{type:'session_info',data:{session_id:'parent'}}}]);
  const detail=await getSessionDetail('parent');
  assert.deepEqual(detail.linkedSessionIds,['child']);
  assert.deepEqual(buildResumeHistory(detail,'full').agentHistory.map(m=>m.content),['node question','node answer']);
  const reverse=await getSessionDetail('child');
  assert.deepEqual(buildResumeHistory(reverse,'full').agentHistory.map(m=>m.content),['node question','node answer']);
});

test('a final event already inside the saved combined reply is not displayed twice', () => {
  const users=[{role:'user',content:'question',order:0}];
  const history=[...users,{role:'assistant',content:'Earlier progress.\nFinal answer.',order:3}];
  const items=rustResumeItems(users,[{order:2,event:{type:'content',data:{text:'Final answer.'}}}],history);
  assert.equal(items.filter(i=>i.kind==='event').length,0);
  assert.equal(items.filter(i=>i.role==='assistant').length,1);
});
