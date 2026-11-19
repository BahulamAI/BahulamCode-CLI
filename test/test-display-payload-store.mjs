import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DisplayPayloadStore } from '../src/daemon/display-payload-store.mjs';

test('details survive a fresh store and memory eviction; sessions and integrity remain isolated', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'display-cache-'));
  try {
    const options = { directory, memoryLimit: 50, diskLimit: 4000 };
    const store = new DisplayPayloadStore(options);
    const payload = { output: 'complete result '.repeat(20) };
    const ref = store.put('session-one', JSON.stringify(payload));
    await store.flush();
    assert.equal(store.memory.size, 0);
    const reopened = new DisplayPayloadStore(options);
    assert.deepEqual(await reopened.get(ref, 'session-one'), payload);
    assert.equal(await reopened.get(ref, 'session-two'), undefined);
    assert.equal(await reopened.get('display:../../secret', 'session-one'), undefined);
    const file = path.join(directory, ref.replaceAll(':', '-') + '.json');
    await fs.writeFile(file, '{"output":"tampered"}');
    assert.equal(await new DisplayPayloadStore(options).get(ref, 'session-one'), undefined);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('disk quota and expiration evict old display payloads without touching unrelated files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'display-cache-'));
  try {
    const options = { directory, memoryLimit: 0, diskLimit: 180, maxAgeMs: 10000 };
    const store = new DisplayPayloadStore(options);
    await fs.writeFile(path.join(directory, 'keep.jsonl'), 'canonical');
    const first = store.put('s', JSON.stringify({ output: 'a'.repeat(100) }));
    await store.flush();
    const firstFile = path.join(directory, first.replaceAll(':', '-') + '.json');
    await fs.utimes(firstFile, new Date(0), new Date(0));
    const second = store.put('s', JSON.stringify({ output: 'b'.repeat(100) }));
    await store.flush();
    assert.equal(await store.get(first, 's'), undefined);
    assert.equal((await store.get(second, 's')).output, 'b'.repeat(100));
    assert.equal(await fs.readFile(path.join(directory, 'keep.jsonl'), 'utf8'), 'canonical');
    assert.equal(store.put('s', 'x'.repeat(181)), undefined);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Rust-retained details remain readable after broadcaster detach without enabling event logs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'display-live-'));
  process.env.BAHULAM_HOME = directory;
  process.env.BAHULAM_DAEMON_EVENTLOG = '0';
  const { registerBroadcaster, tapSseEvent } = await import('../src/daemon/event-tap.mjs');
  const { displayPayloadStore } = await import('../src/daemon/display-payload-store.mjs');
  const frames = [];
  const unregister = registerBroadcaster(frame => frames.push(frame), { schemaVersion: 2, live: true, retainDetails: true });
  const source = { type: 'tool_done', data: { tool_call_id: 'large-tool', output: 'result\n'.repeat(2000) } };
  const before = JSON.stringify(source);
  try {
    tapSseEvent(source, { sessionId: 'retained-session' });
    unregister();
    await displayPayloadStore().flush();
    assert.equal(JSON.stringify(source), before);
    assert.match(frames[0].payload_ref, /^display:/);
    const fresh = new DisplayPayloadStore({ directory: path.join(directory, 'cache', 'display-payloads') });
    assert.equal((await fresh.get(frames[0].payload_ref, 'retained-session')).output, source.data.output);
    assert.equal(await fresh.get(frames[0].payload_ref, 'other-session'), undefined);
    assert.deepEqual(await fs.readdir(directory), ['cache']);
  } finally { unregister(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('reopened truncated JSONL events resolve full payloads without editing the transcript; ambiguous matches are refused', async () => {
  const { sanitizeEventValue } = await import('../src/core/history-event-value.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'display-reopen-'));
  try {
    const options={directory,memoryLimit:0};
    const store=new DisplayPayloadStore(options);
    const event={type:'tool_done',data:{tool_call_id:'stable-id',output:'prefix '.repeat(2000)+'tail one'}};
    const saved=JSON.parse(JSON.stringify(sanitizeEventValue(event)));
    assert.ok(saved.data.output.endsWith('[...truncated...]'));
    const ref=store.put('session',JSON.stringify({output:event.data.output}),event);
    await store.flush();
    const fresh=new DisplayPayloadStore(options);
    const resolved=await fresh.referenceForEvent(saved,'session',await fresh.indexForSession('session'));
    assert.equal(resolved,ref);
    assert.equal((await fresh.get(resolved,'session')).output,event.data.output);
    assert.equal(await fresh.referenceForEvent(saved,'different-session'),undefined);
    const conflict={...event,data:{...event.data,output:'prefix '.repeat(2000)+'different tail'}};
    fresh.put('session',JSON.stringify({output:conflict.data.output}),conflict);
    await fresh.flush();
    assert.equal(await new DisplayPayloadStore(options).referenceForEvent(saved,'session'),undefined);
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
