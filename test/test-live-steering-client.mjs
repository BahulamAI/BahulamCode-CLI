/**
 * Live-steering CLI client tests (PRD-081 §5.2).
 *
 * Covers TarangStreamClient.sendIntervention(): idempotency-key generation,
 * status-object normalization across the backend's response shapes
 * (accepted, queued_next_turn, duplicate), non-2xx error handling, and
 * no-task early return.
 *
 * Uses a fetch stub — no real HTTP.
 */
import assert from 'node:assert';

import { TarangStreamClient, EVENT_TYPES } from '../src/core/stream-client.mjs';

process.env.BAHULAM_RUNTIME_MODE = 'remote';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

console.log('\n\x1b[1mtest-live-steering-client.mjs\x1b[0m\n');

// ── Fetch stub helpers ──────────────────────────────────────────────────

function stubFetchOnce(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(text, status = 500) {
  return {
    ok: false,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => text,
  };
}

function makeClient() {
  const c = new TarangStreamClient({ baseUrl: 'http://backend', token: 't' });
  c.currentTaskId = 'task-xyz';
  return c;
}

// ── EVENT_TYPES surface ─────────────────────────────────────────────────

await test('EVENT_TYPES exposes the three intervention event names', () => {
  assert.strictEqual(EVENT_TYPES.USER_INTERVENTION_ACCEPTED, 'user_intervention_accepted');
  assert.strictEqual(EVENT_TYPES.USER_INTERVENTION_DELIVERED, 'user_intervention_delivered');
  assert.strictEqual(EVENT_TYPES.USER_INTERVENTION_QUEUED, 'user_intervention_queued');
});

// ── sendIntervention behavior ───────────────────────────────────────────

await test('sendIntervention returns {status:no_task} when no active task', async () => {
  const c = new TarangStreamClient({ baseUrl: 'http://backend', token: 't' });
  // currentTaskId intentionally unset
  const r = await c.sendIntervention('hi');
  assert.strictEqual(r.status, 'no_task');
});

await test('sendIntervention rejects empty/whitespace instruction locally', async () => {
  const c = makeClient();
  const r1 = await c.sendIntervention('');
  const r2 = await c.sendIntervention('   \n  ');
  assert.strictEqual(r1.status, 'error');
  assert.strictEqual(r2.status, 'error');
});

await test('sendIntervention posts to /api/intervention/{task_id} with instruction + id', async () => {
  const c = makeClient();
  const stub = stubFetchOnce(() => jsonResponse({
    status: 'accepted',
    task_id: 'task-xyz',
    intervention_id: 'iv-1',
  }));
  const r = await c.sendIntervention('also update the tests', { idempotencyKey: 'iv-1' });
  stub.restore();

  assert.strictEqual(stub.calls.length, 1);
  const { url, opts } = stub.calls[0];
  assert.strictEqual(url, 'http://backend/api/intervention/task-xyz');
  assert.strictEqual(opts.method, 'POST');
  const body = JSON.parse(opts.body);
  assert.strictEqual(body.instruction, 'also update the tests');
  assert.strictEqual(body.intervention_id, 'iv-1');
  assert.strictEqual(r.status, 'accepted');
  assert.strictEqual(r.interventionId, 'iv-1');
});

await test('sendIntervention auto-generates an idempotency key when none supplied', async () => {
  const c = makeClient();
  const stub = stubFetchOnce(() => jsonResponse({
    status: 'accepted',
    task_id: 'task-xyz',
    // Simulate backend echoing back the id we sent
  }));
  const r = await c.sendIntervention('do X');
  stub.restore();
  const sent = JSON.parse(stub.calls[0].opts.body);
  assert.ok(sent.intervention_id, 'client should generate an id');
  assert.ok(sent.intervention_id.length >= 8, 'id should look uuid-ish');
  // Falls back to the client-generated id when backend omits it
  assert.strictEqual(r.interventionId, sent.intervention_id);
});

await test('sendIntervention trims the instruction before sending', async () => {
  const c = makeClient();
  const stub = stubFetchOnce(() => jsonResponse({ status: 'accepted' }));
  await c.sendIntervention('  do the thing  \n');
  stub.restore();
  const sent = JSON.parse(stub.calls[0].opts.body);
  assert.strictEqual(sent.instruction, 'do the thing');
});

await test('sendIntervention normalizes duplicate response to status:duplicate', async () => {
  const c = makeClient();
  const stub = stubFetchOnce(() => jsonResponse({
    status: 'accepted',
    task_id: 'task-xyz',
    intervention_id: 'iv-2',
    duplicate: true,
  }));
  const r = await c.sendIntervention('same as before', { idempotencyKey: 'iv-2' });
  stub.restore();
  assert.strictEqual(r.status, 'duplicate');
  assert.strictEqual(r.interventionId, 'iv-2');
});

await test('sendIntervention surfaces queued_next_turn for terminal tasks', async () => {
  const c = makeClient();
  const stub = stubFetchOnce(() => jsonResponse({
    status: 'queued_next_turn',
    task_id: 'task-xyz',
    intervention_id: 'iv-3',
  }));
  const r = await c.sendIntervention('post-hoc note');
  stub.restore();
  assert.strictEqual(r.status, 'queued_next_turn');
  assert.strictEqual(r.interventionId, 'iv-3');
});

await test('sendIntervention returns {status:error, httpStatus} on non-2xx', async () => {
  const c = makeClient();
  const stub = stubFetchOnce(() => textResponse('task not found', 404));
  const r = await c.sendIntervention('hi', { idempotencyKey: 'iv-err' });
  stub.restore();
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.httpStatus, 404);
  assert.ok(r.error && r.error.includes('task not found'));
  // Even on error, the client returns the id it tried to submit so the caller
  // can log/retry with the same key.
  assert.strictEqual(r.interventionId, 'iv-err');
});

await test('sendIntervention returns {status:error} on network throw', async () => {
  const c = makeClient();
  const stub = stubFetchOnce(() => { throw new Error('ECONNREFUSED'); });
  const r = await c.sendIntervention('hi');
  stub.restore();
  assert.strictEqual(r.status, 'error');
  assert.ok(r.error && r.error.includes('ECONNREFUSED'));
});

await test('sendIntervention idempotency key retries stay stable across calls', async () => {
  const c = makeClient();
  const stub = stubFetchOnce((_url, opts) => {
    const body = JSON.parse(opts.body);
    // First call → accepted; second call with same id → duplicate
    return jsonResponse({
      status: 'accepted',
      intervention_id: body.intervention_id,
      duplicate: stub.calls.length > 1,
    });
  });
  const key = 'iv-retry';
  const first = await c.sendIntervention('same thing', { idempotencyKey: key });
  const second = await c.sendIntervention('same thing', { idempotencyKey: key });
  stub.restore();
  assert.strictEqual(first.status, 'accepted');
  assert.strictEqual(first.interventionId, key);
  assert.strictEqual(second.status, 'duplicate');
  assert.strictEqual(second.interventionId, key);
});

console.log(`\n\x1b[32m${passed} passed\x1b[0m\n`);
