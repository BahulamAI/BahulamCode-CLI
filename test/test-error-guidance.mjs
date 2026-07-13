import assert from 'node:assert';
import { formatAgentErrorGuidance, isBedrockMissingCredentials } from '../src/core/error-guidance.mjs';

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

console.log('\n\x1b[1mtest-error-guidance.mjs\x1b[0m\n');

test('detects Bedrock missing AWS credentials from gateway message', () => {
  const data = {
    message: 'BedrockGateway requires AWS credentials. Pass aws_access_key_id and aws_secret_access_key in config.extra.',
    code: 'gateway_authentication_error',
    phase: 'gateway',
    provider: 'bedrock',
    task_id: 'task_123',
  };

  assert.strictEqual(isBedrockMissingCredentials(data), true);
  const guidance = formatAgentErrorGuidance(data);
  assert.strictEqual(guidance.title, 'AWS Bedrock credentials are missing.');
  assert.ok(guidance.lines.some((line) => line.includes('Access Key ID')));
  assert.ok(guidance.lines.some((line) => line.includes('Kepler/AppStak')));
  assert.ok(guidance.meta.includes('provider=bedrock'));
  assert.ok(guidance.meta.includes('phase=gateway'));
  assert.ok(guidance.meta.includes('task=task_123'));
});

test('gateway errors produce generic provider settings guidance', () => {
  const guidance = formatAgentErrorGuidance({
    message: 'Provider rejected request.',
    code: 'gateway_invalid_request',
    phase: 'gateway',
    provider: 'openrouter',
  });

  assert.strictEqual(guidance.title, 'Provider rejected request.');
  assert.ok(guidance.lines.some((line) => line.includes('provider gateway failed')));
  assert.ok(guidance.meta.includes('provider=openrouter'));
});

console.log(`\n  ${passed} passed, 0 failed\n`);
