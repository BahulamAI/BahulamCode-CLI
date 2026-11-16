import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalManager } from '../src/core/approval.mjs';
import { createRustApprovalBridge } from '../src/daemon/rust-approval.mjs';

function fixture(t, hitl = { allowSessionTrust: true, allowProjectTrust: true }) {
  t.mock.method(process.stderr, 'write', () => true);
  const events = [], log = [], grants = [];
  const bridge = createRustApprovalBridge({ emit: (type, data) => events.push({ type, data }) });
  const manager = new ApprovalManager({ cwd: '/fixture', policy: { hitl },
    trustStore: { find: () => null, add: grant => { grants.push(grant); return {id:'rule',pattern:'fixture'}; } },
    approvalLog: { append: event => log.push(event) }, getPromptHandler: () => bridge.choose });
  return { manager, bridge, events, log, grants };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Rust presentation retains Node auto-approval, plan blocks and hard safety blocks', async t => {
  const { manager, events } = fixture(t);
  assert.equal((await manager.check('bahulam_info', {query:'where are you located?',topic:'runtime'}, true)).approved, true);
  manager.planMode = true;
  assert.equal((await manager.check('write_file', {path:'file.js',content:'x'})).approved, false);
  manager.planMode = false;
  assert.equal((await manager.check('shell', {command:'rm -rf /'})).approved, false);
  assert.equal(events.length, 0);
});

test('Rust decisions use real request IDs and the existing type grant/logging', async t => {
  const { manager, bridge, events, log } = fixture(t);
  const pending = manager.check('unknown_info', {query:'where are you located?',topic:'runtime'}, true, {reason:'backend request'});
  await tick();
  const request = events[0].data;
  assert.equal(request.name, 'unknown_info');
  assert.equal(request.cwd, '/fixture');
  assert.equal(request.reason, 'backend request');
  assert.deepEqual(request.scopes, ['once','type']);
  assert.equal(bridge.answer('approve', {apr_id:'backend-call',scope:'once'}), false);
  assert.equal(bridge.answer('approve', {apr_id:request.apr_id,scope:'project'}), false);
  assert.equal(bridge.answer('approve', {apr_id:request.apr_id,scope:'type'}), true);
  assert.equal((await pending).approved, true);
  assert.ok(manager.approvedToolTypes.has('unknown_info'));
  assert.equal(log.at(-1).decision, 'type-approve');
  assert.equal((await manager.check('unknown_info', {})).approved, true);
  assert.equal(events.filter(event => event.type === 'approval_required').length, 1);
  assert.equal(bridge.answer('approve', {apr_id:request.apr_id}), false);
});

test('session scopes are constrained by Node policy and dangerous tiers stay once-only', async t => {
  for (const allowed of [true, false]) {
    const { manager, bridge, events, grants } = fixture(t, {allowSessionTrust:allowed});
    const pending = manager.check('shell', {command:'custom-cli inspect'});
    await tick();
    const request = events[0].data;
    assert.equal(request.scopes.includes('session'), allowed);
    bridge.answer('approve', {apr_id:request.apr_id,scope:allowed ? 'session' : 'once'});
    assert.equal((await pending).approved, true);
    assert.equal(grants.length, allowed ? 1 : 0);
  }
  const { manager, bridge, events } = fixture(t);
  const pending = manager.check('read_file', {path:'.env'});
  await tick();
  assert.deepEqual(events[0].data.scopes, ['once']);
  bridge.answer('deny', {apr_id:events[0].data.apr_id});
  assert.equal((await pending).approved, false);
});

test('cancel denies active and queued approvals; history never creates a pending request', async t => {
  const { manager, bridge, events } = fixture(t);
  const first = manager.check('unknown_a', {});
  const second = manager.check('unknown_b', {});
  await tick();
  assert.equal(events.length, 1);
  bridge.cancel();
  assert.equal((await first).approved, false);
  assert.equal((await second).approved, false);
  assert.equal(events.filter(event => event.type === 'approval_required').length, 1);
  bridge.close();
  assert.equal((await manager.check('unknown_c', {})).approved, false);
});

test('renderer cannot grant a scope absent from the Node options', async t => {
  const { manager, grants } = fixture(t);
  manager.getPromptHandler = () => async () => 'allow-project';
  const result = await manager.check('read_file', {path:'.env'});
  assert.equal(result.approved, false);
  assert.equal(grants.length, 0);
});

test('backend approval names normalize without inventing a local approval handle', async () => {
  const { tapSseEvent, registerBroadcaster } = await import('../src/daemon/event-tap.mjs');
  const frames = [];
  const unsubscribe = registerBroadcaster(event => frames.push(event), {schemaVersion:2,live:true});
  try {
    const data = {tool:'bahulam_info',tool_id:'backend-call',args:{topic:'runtime'},risk:'read'};
    tapSseEvent({type:'approval_required',data}, {sessionId:'approval-projection-fixture'});
    const frame = frames.at(-1);
    assert.equal(frame.data.name, 'bahulam_info');
    assert.equal(frame.data.risk_tier, 'read');
    assert.equal(frame.data.apr_id, '');
    assert.equal(data.name, undefined);
    tapSseEvent({type:'approval_required',data:{apr_id:'local-large',name:'shell',args:{command:'x'.repeat(5000)},scopes:['once','session']}}, {sessionId:'approval-projection-fixture'});
    assert.deepEqual(frames.at(-1).data.scopes, ['once','session']);
    assert.ok(frames.at(-1).payload_ref);
  } finally {unsubscribe();}
});


test('existing socket/mobile registry can answer a Rust prompt and cancellation clears it', async t => {
  const { resolvePending, listPending } = await import('../src/daemon/approval-store.mjs');
  const { manager, events, bridge } = fixture(t);
  const pending = manager.check('unknown_tool', {});
  await tick();
  const id = events[0].data.apr_id;
  assert.ok(listPending().some(entry => entry.apr_id === id));
  assert.equal(resolvePending('approve', id, 'remote-fixture'), true);
  assert.equal((await pending).approved, true);
  assert.equal(events.at(-1).data.decided_by, 'remote-fixture');
  assert.ok(!listPending().some(entry => entry.apr_id === id));
  const next = manager.check('unknown_tool', {});
  await tick();
  bridge.close();
  assert.equal((await next).approved, false);
  assert.equal(listPending().length, 0);
});
