/**
 * Tests for PRD-065 rolling message window display helpers.
 */

import assert from 'node:assert';
import {
    formatMessageWindow,
    formatRetryAfter,
    lowWindowStatus,
    messagesRemaining,
    normalizeRateLimit,
    rateLimitErrorMessage,
    resetLabel,
} from '../src/core/rate-limit-display.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (err) {
        console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
        failed++;
    }
}

console.log('\n\x1b[1mtest-rate-limit-display.mjs\x1b[0m\n');

test('normalizes numeric strings and retry aliases', () => {
    const normalized = normalizeRateLimit({
        msgs_used_in_window: '4',
        msgs_per_window: '50',
        configured_msgs_per_window: '25',
        retry_after_seconds: '60',
        unlimited: 0,
        byok: 0,
    });

    assert.strictEqual(normalized.msgs_used_in_window, 4);
    assert.strictEqual(normalized.msgs_per_window, 50);
    assert.strictEqual(normalized.configured_msgs_per_window, 25);
    assert.strictEqual(normalized.retry_after, 60);
    assert.strictEqual(normalized.unlimited, false);
    assert.strictEqual(normalized.byok, false);
});

test('messagesRemaining returns remaining count', () => {
    assert.strictEqual(messagesRemaining({
        msgs_used_in_window: 5,
        msgs_per_window: 50,
    }), 45);
});

test('messagesRemaining returns Infinity for unlimited plans', () => {
    assert.strictEqual(messagesRemaining({ unlimited: true, msgs_per_window: 50 }), Infinity);
    assert.strictEqual(messagesRemaining({ msgs_per_window: -1 }), Infinity);
});

test('formatRetryAfter formats rounded minutes and hours', () => {
    assert.strictEqual(formatRetryAfter(10), '1m');
    assert.strictEqual(formatRetryAfter(61), '2m');
    assert.strictEqual(formatRetryAfter(3600), '1h');
    assert.strictEqual(formatRetryAfter(3660), '1h 1m');
});

test('resetLabel uses provided clock', () => {
    assert.strictEqual(resetLabel({
        window_reset_at: '2026-07-06T05:00:00Z',
    }, Date.parse('2026-07-06T04:30:00Z')), '30m');
});

test('formatMessageWindow includes tier, remaining messages, and reset', () => {
    const label = formatMessageWindow({
        tier: 'pro',
        msgs_used_in_window: 4,
        msgs_per_window: 50,
        window_reset_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    assert.ok(label.includes('PRO'));
    assert.ok(label.includes('46 / 50 messages this window'));
    assert.ok(label.includes('resets in'));
});

test('formatMessageWindow hides reset when requested', () => {
    const label = formatMessageWindow({
        tier: 'free',
        msgs_used_in_window: 4,
        msgs_per_window: 50,
        window_reset_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }, { includeReset: false });

    assert.strictEqual(label, 'FREE · 46 / 50 messages this window');
});

test('formatMessageWindow reports unlimited for BYOK', () => {
    assert.strictEqual(formatMessageWindow({
        tier: 'pro',
        byok: true,
        msgs_per_window: 50,
    }), 'PRO · unlimited messages');
});

test('lowWindowStatus returns ok, low, and exhausted', () => {
    assert.strictEqual(lowWindowStatus({ msgs_used_in_window: 10, msgs_per_window: 50 }), 'ok');
    assert.strictEqual(lowWindowStatus({ msgs_used_in_window: 45, msgs_per_window: 50 }), 'low');
    assert.strictEqual(lowWindowStatus({ msgs_used_in_window: 50, msgs_per_window: 50 }), 'exhausted');
});

test('rateLimitErrorMessage uses backend message first', () => {
    assert.strictEqual(rateLimitErrorMessage({
        detail: {
            message: 'Custom backend message',
            retry_after: 3600,
        },
    }), 'Custom backend message');
});

test('rateLimitErrorMessage formats retry_after fallback', () => {
    assert.strictEqual(rateLimitErrorMessage({
        detail: {
            retry_after: 3660,
        },
    }), 'Message window exhausted — try again in 1h 1m, or upgrade your plan.');
});

test('rateLimitErrorMessage normalizes billing URL in string credit exhaustion detail', () => {
    assert.strictEqual(rateLimitErrorMessage({
        detail: 'Credit balance exhausted. Purchase credits or add your own API key (BYOK) at codekepler.ai/pricing',
    }), 'Credit balance exhausted. Purchase credits or add your own API key (BYOK) at bahulam.ai/pricing');
});

test('rateLimitErrorMessage gives credit exhaustion action message from code', () => {
    assert.strictEqual(rateLimitErrorMessage({
        detail: {
            code: 'credit_balance_exhausted',
        },
    }), 'Credit balance exhausted — add credits, upgrade your plan, or switch to BYOK in Settings.');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
