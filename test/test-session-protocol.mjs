import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createEventLog, readAllEvents } from '../src/core/event-log.mjs';
import { toLegacyEvent } from '../src/protocol/compat.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-v2-'));
process.env.BAHULAM_HOME = temp;
const { tapSseEvent, closeActiveEventLog, registerBroadcaster } = await import('../src/daemon/event-tap.mjs');
const schema = JSON.parse(fs.readFileSync(new URL('../src/protocol/session-v2.schema.json', import.meta.url)));
const fixtures = name => fs.readFileSync(new URL(`./fixtures/protocol/${name}`, import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
function checkShape(data, definition) {
  assert.equal(typeof data, 'object');
  for (const key of definition.required) assert.ok(Object.hasOwn(data, key), `Missing ${key}`);
  for (const [key, field] of Object.entries(definition.properties)) {
    if (data[key] === undefined) continue;
    if (field.type === 'array') assert.ok(Array.isArray(data[key]), key);
    else if (field.type === 'integer') assert.ok(Number.isInteger(data[key]), key);
    else if (Array.isArray(field.type)) assert.ok(data[key] === null || typeof data[key] === 'string', key);
    else if (field.type) assert.equal(typeof data[key], field.type, key);
  }
}
try {
  execFileSync(process.execPath, ['scripts/generate-session-protocol.mjs', '--check'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
  const golden = fixtures('events-v2.jsonl');
  assert.deepEqual(golden.map(e => e.type).sort(), Object.keys(schema['x-event-payloads']).sort());
  for (const event of golden) {
    checkShape(event, schema);
    checkShape(event.data, schema.$defs[schema['x-event-payloads'][event.type]]);
    assert.ok(event.id && event.agent_id && Object.hasOwn(event, 'turn_id'));
  }
  const commands = fixtures('commands-v2.jsonl');
  assert.deepEqual(commands.map(c => c.type).sort(), Object.keys(schema['x-command-payloads']).sort());
  for (const command of commands) checkShape(command.data, schema.$defs[schema['x-command-payloads'][command.type]]);

  const dir = path.join(temp, 'direct');
  let log = createEventLog({ sessionId: 'sess_direct', sessionDir: dir, flushIntervalMs: 100000 });
  const first = log.appendEvent('tool_requested', { tool_id: 'tc_a', name: 'read', args: {} }, { turnId: 't1' });
  const second = log.appendEvent('tool_finished', { tool_id: 'tc_a', ok: true, summary: 'ok', output: '界'.repeat(6000) }, { turnId: 't1' });
  assert.notEqual(first.id, second.id);
  assert.equal(first.data.tool_id, second.data.tool_id);
  assert.ok(second.payload_ref);
  assert.ok(Buffer.byteLength(JSON.stringify(second.data)) < 4096);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, second.payload_ref))).output.length, 6000);
  assert.equal(fs.statSync(path.join(dir, second.payload_ref)).mode & 0o777, 0o600);
  await log.close();
  assert.deepEqual(await readAllEvents({ sessionId: 'sess_direct', sessionDir: dir }), [first, second]);
  fs.writeFileSync(path.join(dir, '.seq'), '0'); // crash after append but before checkpoint
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"seq":'); // torn final record
  log = createEventLog({ sessionId: 'sess_direct', sessionDir: dir });
  assert.equal(log.currentSeq(), 2);
  assert.equal(log.writeEvent('notice', { level: 'info', title: 'Recovered' }), 3);
  await log.close();
  assert.equal((await readAllEvents({ sessionId: 'sess_direct', sessionDir: dir })).length, 3);
  fs.renameSync(path.join(dir, 'events.jsonl'), path.join(dir, 'events-1.jsonl'));
  fs.unlinkSync(path.join(dir, '.seq'));
  log = createEventLog({ sessionId: 'sess_direct', sessionDir: dir });
  assert.equal(log.currentSeq(), 3, 'recover rolled-only log without reusing IDs');
  await log.close();

  fs.copyFileSync(new URL('./fixtures/protocol/replay-v1.jsonl', import.meta.url), path.join(dir, 'events.jsonl'));
  fs.unlinkSync(path.join(dir, 'events-1.jsonl'));
  assert.equal((await readAllEvents({ sessionId: 'sess_legacy', sessionDir: dir })).length, 5, 'v1 stays readable');

  process.env.BAHULAM_DAEMON_EVENTLOG = '1';
  const modern = [], legacy = [];
  registerBroadcaster(e => modern.push(structuredClone(e)), { schemaVersion: 2 });
  registerBroadcaster(e => legacy.push(e));
  const sessionId = 'sess_tap';
  const tap = (type, data) => tapSseEvent({ type, data }, { sessionId });
  tap('session_info', { cwd: '/project', model: 'fixture' });
  tap('content_partial', { text: 'Hello ' });
  tap('content_partial', { text: 'world' });
  tap('content', { text: 'Hello world' });
  tap('sub_agent_start', { run_id: 'run_review', type: 'review', query: 'Inspect changes' });
  const request = Object.freeze({ tool: 'read_file', call_id: 'tc_1', sub_agent_run_id: 'run_review', args: Object.freeze({ path: 'app.js' }) });
  tap('tool_request', request);
  tap('tool_result', { call_id: 'tc_1', run_id: 'run_review', success: false, output: 'failed', duration_ms: 0 });
  tap('sub_agent_complete', { run_id: 'run_review', summary: 'Review done', tokens: 2400, cost_usd: 0.012, duration_ms: 1250 });
  tap('plan_created', { items: [{ id: 'p1', text: 'Fix test', state: 'pending' }] });
  tap('complete', { summary: 'Done' });
  tap('content_partial', { text: 'Next turn' });
  tap('error', { error: { code: 'TEST_ERROR', message: 'A structured failure' } });
  await closeActiveEventLog();
  const disk = await readAllEvents({ sessionId });
  assert.deepEqual(modern, disk, 'live and replay envelopes, timestamps and IDs are identical');
  assert.deepEqual(legacy, disk.map(toLegacyEvent).filter(Boolean));
  assert.ok(!legacy.some(e => e.type === 'text_delta'), 'v1 clients do not receive unknown per-token frames');
  for (const event of disk) checkShape(event.data, schema.$defs[schema['x-event-payloads'][event.type]]);
  assert.equal(disk[0].turn_id, null);
  assert.equal(disk[1].type, 'text_delta');
  assert.equal(disk[3].data.final_text_hash.length, 64);
  assert.equal(disk[5].agent_id, 'run_review');
  assert.equal(disk[5].parent_agent_id, 'main');
  assert.equal(disk[5].data.tool_id, disk[6].data.tool_id);
  assert.equal(disk[6].data.ok, false);
  assert.equal(disk[6].data.duration_ms, 0);
  assert.equal(disk[7].agent_id, 'run_review');
  assert.deepEqual(disk[7].data.tokens, { total: 2400 });
  assert.equal(disk[7].data.cost_usd, 0.012);
  assert.equal(disk[7].data.elapsed_ms, 1250);
  assert.notEqual(disk[9].turn_id, disk[10].turn_id, 'separate turns receive separate IDs');
  assert.equal(new Set(disk.map(e => e.id)).size, disk.length);
  tap('sub_agent_tool', {run_id:'worker-large-report',tool:'grep'});
  tap('sub_agent_tool_result', {run_id:'worker-large-report',tool:'grep',success:true});
  tap('sub_agent_complete', {run_id:'worker-large-report',summary:'Report line\n'.repeat(1000),tokens:{input_tokens:12000,output_tokens:4000},cost_usd:0.15,duration_ms:4200});
  await closeActiveEventLog();
  const finalEvents = await readAllEvents({sessionId});
  assert.equal(finalEvents.at(-3).agent_id,'worker-large-report');
  assert.equal(finalEvents.at(-3).data.current_tool,'grep');
  assert.equal(finalEvents.at(-3).data.tool_active,true);
  assert.equal(finalEvents.at(-2).data.tool_active,false);
  const large = finalEvents.at(-1);
  assert.ok(large.payload_ref, 'large report retains its complete payload');
  assert.equal(large.data.total_tokens,16000,'bounded metadata retains available worker usage');
  assert.equal(large.data.cost_usd,0.15);
  assert.equal(large.data.elapsed_ms,4200);
  console.log('PASS: generated schema/types, golden events/commands, v1 replay, v2 identities, payload references, crash recovery, agent attribution and identical live/replay frames.');
} finally {
  await closeActiveEventLog();
  fs.rmSync(temp, { recursive: true, force: true });
}
