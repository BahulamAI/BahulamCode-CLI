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
