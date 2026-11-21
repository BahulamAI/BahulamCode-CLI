import assert from 'node:assert/strict';
import { fetchWithRetry, isNetworkError, requestErrorData } from '../src/core/request-retry.mjs';

const originalRandom = Math.random;
Math.random = () => 0.5;
try {
  let calls = 0;
  const response = await fetchWithRetry('http://test', {}, {
    fetchImpl: async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('socket dropped'), { code: 'ECONNRESET' });
      return new Response('{}', { status: 200 });
    },
    maxRetries: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);

  calls = 0;
  const unauthorized = await fetchWithRetry('http://test', {}, {
    fetchImpl: async () => {
      calls++;
      return new Response('{"detail":"Invalid token"}', { status: 401 });
    },
    maxRetries: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls, 1);

  assert.equal(isNetworkError(Object.assign(new Error('down'), { code: 'ENETUNREACH' })), true);
  assert.equal(requestErrorData(Object.assign(new Error('expired'), { status: 401, code: 'gateway_authentication_error' })).retryable, false);
} finally {
  Math.random = originalRandom;
}

console.log('test-request-retry.mjs: passed');

const { safeProviderEvent, providerErrorMessage, gatewayFailure, completionFailure } = await import('../src/core/provider-error.mjs');
const { formatAgentErrorGuidance } = await import('../src/core/error-guidance.mjs');
const privateUrl = 'https://openrouter.ai/workspaces/example/keys/private-key-id';
const legacy = `Error code: 402 - You requested up to 919225 tokens, but can only afford 846169. Visit ${privateUrl}`;
const sanitized = safeProviderEvent({ error: legacy, message: legacy, details: { raw: privateUrl }, fatal: true });
assert.equal(sanitized.http_status, 402);
assert.match(sanitized.message, /919225.*846169/);
assert.equal(sanitized.fatal, true);
assert.ok(!JSON.stringify(sanitized).includes('private-key-id'));
assert.equal(providerErrorMessage(402, legacy), sanitized.message);
assert.deepEqual(formatAgentErrorGuidance(sanitized).lines, []);
assert.equal(gatewayFailure(402, '{"detail":{"code":"credits_exhausted"}}').code, 'credits_exhausted');
assert.ok(!providerErrorMessage(400, '<html>private</html>').includes('private'));
assert.deepEqual(completionFailure({ choices: [{ error: { code: 402, message: legacy } }] }),
    { status: 402, message: sanitized.message });
