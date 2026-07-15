import assert from 'node:assert/strict';

const originalEnv = { ...process.env };

async function loadResolver() {
  return await import(`../src/core/backend-url.mjs?case=${Date.now()}-${Math.random()}`);
}

async function withEnv(env, fn) {
  process.env = { ...originalEnv, ...env };
  try {
    await fn();
  } finally {
    process.env = { ...originalEnv };
  }
}

await withEnv({ TARANG_ENV: 'treetop' }, async () => {
  const { resolveBackendUrl, resolveWebUrl } = await loadResolver();
  assert.equal(
    resolveBackendUrl(),
    'https://codekepler-backend-dev.kindisland-9034322d.eastus.azurecontainerapps.io',
  );
  assert.equal(resolveWebUrl(), 'https://treetop.codekepler.ai');
});

await withEnv({ TARANG_ENV: 'development' }, async () => {
  const { resolveBackendUrl, resolveWebUrl } = await loadResolver();
  assert.equal(
    resolveBackendUrl(),
    'https://codekepler-backend-prod.gentlerock-9816c6b8.centralus.azurecontainerapps.io',
  );
  assert.equal(resolveWebUrl(), 'https://codekepler.ai');
});

await withEnv({ TARANG_ENV: 'production' }, async () => {
  const { resolveBackendUrl, resolveWebUrl } = await loadResolver();
  assert.equal(
    resolveBackendUrl(),
    'https://codekepler-backend-prod.gentlerock-9816c6b8.centralus.azurecontainerapps.io',
  );
  assert.equal(resolveWebUrl(), 'https://codekepler.ai');
});

await withEnv({
  TARANG_ENV: 'development',
  TARANG_BACKEND_URL: 'https://example.test/backend/',
  TARANG_WEB_URL: 'https://example.test/web/',
}, async () => {
  const { resolveBackendUrl, resolveWebUrl } = await loadResolver();
  assert.equal(resolveBackendUrl(), 'https://example.test/backend');
  assert.equal(resolveWebUrl(), 'https://example.test/web');
});

console.log('backend-url resolver tests passed');
