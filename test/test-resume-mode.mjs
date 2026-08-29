import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideResumeMode,
  modelContextWindowInfo,
  modelContextWindow,
  projectedTokensForChoice,
  formatTokens,
} from '../src/core/resume-mode.mjs';

test('decideResumeMode: well under threshold resumes silently in full mode', () => {
  const d = decideResumeMode({
    transcriptTokens: 5000,           // 5k tokens
    model: 'anthropic/claude-sonnet-4', // 200k window
  });
  assert.equal(d.mode, 'full');
  assert.equal(d.defaultChoice, 'full');
  assert.ok(d.usageRatio < 0.10);
});

test('decideResumeMode: above 50% highWatermark asks with full preselected', () => {
  const d = decideResumeMode({
    transcriptTokens: 110_000,          // 110k tokens
    model: 'anthropic/claude-sonnet-4',   // 200k window (55% + 4k overhead)
  });
  assert.equal(d.mode, 'ask');
  assert.equal(d.defaultChoice, 'full');
  assert.ok(d.usageRatio > 0.50 && d.usageRatio < 0.85);
});

test('decideResumeMode: above hardCap disables full mode', () => {
  const d = decideResumeMode({
    transcriptTokens: 180_000,          // 180k tokens
    model: 'anthropic/claude-sonnet-4',   // 200k window ≈ 92%
  });
  assert.equal(d.mode, 'no-full-allowed');
  assert.equal(d.defaultChoice, 'tail-20');
});

test('decideResumeMode: unknown model falls back to default context window', () => {
  const d = decideResumeMode({
    transcriptTokens: 10_000,
    model: 'made-up/unknown-model-x',
  });
  assert.equal(d.windowSize, 128000);  // DEFAULT_CONTEXT_WINDOW
  assert.equal(d.windowKnown, false);
  assert.equal(d.windowSource, 'fallback');
  assert.equal(d.mode, 'full');
});

test('decideResumeMode: custom thresholds honored', () => {
  const d = decideResumeMode({
    transcriptTokens: 30_000,
    model: 'anthropic/claude-sonnet-4',
    settings: { resume: { highWatermark: 0.10, hardCap: 0.20 } },
  });
  // 30k+4k = 34k of 200k = 17% > 10% but < 20% — 'ask'
  assert.equal(d.mode, 'ask');
});

test('decideResumeMode: invalid threshold values fall back to defaults', () => {
  const d = decideResumeMode({
    transcriptTokens: 10_000,
    model: 'anthropic/claude-sonnet-4',
    settings: { resume: { highWatermark: 999, hardCap: -1 } },
  });
  assert.equal(d.highWatermark, 0.50);
  assert.equal(d.hardCap, 0.85);
});

test('modelContextWindow: known + fallback', () => {
  assert.equal(modelContextWindow('anthropic/claude-sonnet-4'), 200000);
  assert.equal(modelContextWindow('deepseek/deepseek-v4-flash'), 128000);
  assert.equal(modelContextWindow('unknown/model'), 128000);
  assert.equal(modelContextWindow(null), 128000);
  assert.deepEqual(modelContextWindowInfo('deepseek/deepseek-v4-flash'), {
    tokens: 128000,
    known: true,
    source: 'model_map',
  });
  assert.deepEqual(modelContextWindowInfo('unknown/model'), {
    tokens: 128000,
    known: false,
    source: 'fallback',
  });
});

test('modelContextWindow: backend catalog hint overrides fallback', () => {
  const hint = { context_length: 300_000, source: 'models_catalog' };
  assert.equal(modelContextWindow('unknown/model', hint), 300_000);
  assert.deepEqual(modelContextWindowInfo('unknown/model', hint), {
    tokens: 300_000,
    known: true,
    source: 'models_catalog',
  });

  const d = decideResumeMode({
    transcriptTokens: 140_000,
    model: 'unknown/model',
    contextWindow: hint,
  });
  assert.equal(d.windowSize, 300_000);
  assert.equal(d.windowKnown, true);
  assert.equal(d.windowSource, 'models_catalog');
  assert.equal(d.mode, 'full');
});

test('projectedTokensForChoice: mode-specific projections', () => {
  assert.equal(projectedTokensForChoice('full', 42000), 42000);
  // Both are constant estimates — same for any input
  assert.ok(projectedTokensForChoice('summary', 999999) < 10000);
  assert.ok(projectedTokensForChoice('tail-10', 999999) < projectedTokensForChoice('tail-20', 999999));
  assert.ok(projectedTokensForChoice('tail-20', 999999) < projectedTokensForChoice('full', 999999));
  assert.equal(projectedTokensForChoice('checkpoint-full', 999999, {
    resumeSummary: { sourceMessageCount: 90, fullMessageCount: 100 },
  }), 7000);
});

test('formatTokens: sub-1k, k-range, M-range', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(500), '500');
  assert.equal(formatTokens(1500), '2k');
  assert.equal(formatTokens(62_000), '62k');
  assert.equal(formatTokens(1_200_000), '1.2M');
});
