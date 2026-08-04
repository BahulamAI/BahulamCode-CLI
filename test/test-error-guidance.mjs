import assert from 'node:assert';
import {
  formatAgentErrorGuidance,
  isBedrockMissingCredentials,
  normalizeGatewayProvider,
} from '../src/core/error-guidance.mjs';

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
  assert.ok(guidance.lines.some((line) => line.includes('Bahulam model settings')));
  assert.ok(guidance.meta.includes('provider=bedrock'));
  assert.ok(guidance.meta.includes('phase=gateway'));
  assert.ok(guidance.meta.includes('task=task_123'));
});

test('gateway errors produce generic provider settings guidance', () => {
  const guidance = formatAgentErrorGuidance({
    message: 'Provider rejected request.',
    code: 'gateway_invalid_request',
    phase: 'gateway',
  });

  assert.strictEqual(guidance.title, 'Provider rejected request.');
  assert.ok(guidance.lines.some((line) => line.includes('provider gateway failed')));
});

test('provider guidance map gives tailored OpenRouter next steps', () => {
  const guidance = formatAgentErrorGuidance({
    message: 'Provider rejected request.',
    code: 'gateway_invalid_request',
    phase: 'gateway',
    provider: 'openrouter',
  });

  assert.ok(guidance.lines.some((line) => line.includes('OpenRouter gateway failed')));
  assert.ok(guidance.lines.some((line) => line.includes('OpenRouter API key')));
  assert.ok(guidance.lines.some((line) => line.includes('provider routing')));
  assert.ok(guidance.meta.includes('provider=openrouter'));
});

test('provider guidance map covers common BYOK gateways', () => {
  const cases = [
    ['anthropic', 'Anthropic API key'],
    ['openai', 'OpenAI API key'],
    ['googleai', 'Google AI API key'],
    ['azureopenai', 'Azure OpenAI API key'],
    ['databricks', 'Databricks host'],
    ['custom', 'base URL'],
    ['deepseek', 'DeepSeek API key'],
    ['dashscope', 'DashScope API key'],
    ['zhipu', 'Zhipu API key'],
    ['moonshot', 'Moonshot API key'],
    ['xai', 'xAI API key'],
    ['mistral', 'Mistral API key'],
  ];

  for (const [provider, expected] of cases) {
    const guidance = formatAgentErrorGuidance({
      message: 'Provider rejected request.',
      code: 'gateway_authentication_error',
      phase: 'gateway',
      provider,
    });
    assert.ok(
      guidance.lines.some((line) => line.includes(expected)),
      `${provider} guidance should mention ${expected}`,
    );
    assert.ok(guidance.meta.includes(`provider=${provider}`));
  }
});

test('normalizes gateway provider aliases from explicit fields and messages', () => {
  assert.strictEqual(normalizeGatewayProvider({ gateway: 'AzureOpenAIGateway' }), 'azureopenai');
  assert.strictEqual(normalizeGatewayProvider({ provider: 'openrouterv2' }), 'openrouter');
  assert.strictEqual(normalizeGatewayProvider({ message: 'MoonshotGateway rejected model kimi-k2' }), 'moonshot');
  assert.strictEqual(normalizeGatewayProvider({ message: 'GLM quota exceeded' }), 'zhipu');
});

test('credit exhaustion guidance gives billing and BYOK actions', () => {
  const guidance = formatAgentErrorGuidance({
    message: 'Credit balance exhausted — add credits, upgrade your plan, or switch to BYOK in Settings.',
    code: 'credit_balance_exhausted',
    pricing_url: 'codekepler.ai/pricing',
  });

  assert.ok(guidance.lines.some((line) => line.includes('Add credits or upgrade')));
  assert.ok(guidance.lines.some((line) => line.includes('BYOK')));
  assert.ok(guidance.lines.some((line) => line.includes('Bahulam credit charges')));
  assert.ok(guidance.lines.some((line) => line.includes('bahulam.ai/pricing')));
});

test('message window guidance explains wait or upgrade decision', () => {
  const guidance = formatAgentErrorGuidance({
    message: 'Message window exhausted — try again in 1h 1m, or upgrade your plan.',
    code: 'message_limit_reached',
    retry_after: 3660,
    pricing_url: 'codekepler.ai/pricing',
  });

  assert.ok(guidance.lines.some((line) => line.includes('message limit')));
  assert.ok(guidance.lines.some((line) => line.includes('Wait 1h 1m')));
  assert.ok(guidance.lines.some((line) => line.includes('larger 5-hour message window')));
  assert.ok(guidance.lines.some((line) => line.includes('bahulam.ai/pricing')));
});

console.log(`\n  ${passed} passed, 0 failed\n`);
