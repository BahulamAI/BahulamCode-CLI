import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rustSessionUsage, rustUsageBaseline } from '../src/daemon/rust-tui-snapshot.mjs';

test('Rust copies core totals and estimates actual history, not cumulative requests', () => {
  const session = { inputTokens: 518000, outputTokens: 1500, totalCost: 0.2345,
    costAccurate: true, lastTurnInputTokens: 510000, modelLimits: { coder: { context_length: 128000 } },
    agentHistory: [{role:'user',content:'x'.repeat(120000)}] };
  const before = JSON.stringify(session);
  const usage = rustSessionUsage(session);
  assert.equal(usage.input_tokens, 518000);
  assert.equal(usage.output_tokens, 1500);
  assert.equal(usage.cost_usd, 0.2345);
  assert.equal(usage.cost_estimated, false);
  assert.equal(usage.context_estimated, true);
  assert.ok(usage.context_tokens >= 30000 && usage.context_tokens < 30100);
  assert.ok(usage.context_used_pct > 23 && usage.context_used_pct < 24);
  assert.equal(JSON.stringify(session), before);
});

test('resume replaces display totals; repeated snapshots do not add usage', () => {
  const session = {inputTokens: 10000, outputTokens: 1000, totalCost: 1, agentHistory: []};
  const saved = {inputTokens: 2345, outputTokens: 67, costUsd: 0.12};
  session.rustUsageBaseline = rustUsageBaseline(session, saved);
  const first = rustSessionUsage(session);
  assert.equal(first.input_tokens, 2345);
  assert.equal(first.output_tokens, 67);
  assert.equal(first.cost_usd, 0.12);
  session.rustUsageBaseline = rustUsageBaseline(session, saved);
  assert.deepEqual(rustSessionUsage(session), first);
  session.inputTokens += 200;
  session.outputTokens += 20;
  session.totalCost += 0.01;
  const next = rustSessionUsage(session);
  assert.equal(next.input_tokens, 2545);
  assert.equal(next.output_tokens, 87);
  assert.ok(Math.abs(next.cost_usd - 0.13) < 1e-9);
  assert.deepEqual(rustSessionUsage(session), next);
  session.rustUsageBaseline = null;
  session.inputTokens = session.outputTokens = session.totalCost = 0;
  assert.equal(rustSessionUsage(session).input_tokens, 0);
  assert.equal(rustSessionUsage(session).context_used_pct, 0);
});
