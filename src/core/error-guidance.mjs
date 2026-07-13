function compact(value) {
  return String(value || '').trim();
}

function lower(value) {
  return compact(value).toLowerCase();
}

const PROVIDER_ALIASES = new Map([
  ['openrouter', 'openrouter'],
  ['openrouterv2', 'openrouter'],
  ['openroutergateway', 'openrouter'],
  ['openrouterv2gateway', 'openrouter'],
  ['anthropic', 'anthropic'],
  ['claude', 'anthropic'],
  ['claudegateway', 'anthropic'],
  ['openai', 'openai'],
  ['openaigateway', 'openai'],
  ['google', 'googleai'],
  ['googleai', 'googleai'],
  ['googlegateway', 'googleai'],
  ['googleaigateway', 'googleai'],
  ['gemini', 'googleai'],
  ['azure', 'azureopenai'],
  ['azureopenai', 'azureopenai'],
  ['azureopenaigateway', 'azureopenai'],
  ['bedrock', 'bedrock'],
  ['aws', 'bedrock'],
  ['bedrockgateway', 'bedrock'],
  ['databricks', 'databricks'],
  ['databricksgateway', 'databricks'],
  ['custom', 'custom'],
  ['byom', 'custom'],
  ['openai-compatible', 'custom'],
  ['deepseek', 'deepseek'],
  ['deepseekgateway', 'deepseek'],
  ['dashscope', 'dashscope'],
  ['dashscopegateway', 'dashscope'],
  ['qwen', 'dashscope'],
  ['zhipu', 'zhipu'],
  ['zhipugateway', 'zhipu'],
  ['glm', 'zhipu'],
  ['moonshot', 'moonshot'],
  ['moonshotgateway', 'moonshot'],
  ['kimi', 'moonshot'],
  ['xai', 'xai'],
  ['xaigateway', 'xai'],
  ['grok', 'xai'],
  ['mistral', 'mistral'],
  ['mistralgateway', 'mistral'],
]);

const PROVIDER_GUIDANCE = {
  openrouter: {
    label: 'OpenRouter',
    lines: [
      'Check that your OpenRouter API key is saved and has enough credits/quota.',
      'Verify the selected model is available on OpenRouter and that provider routing is allowed for it.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  anthropic: {
    label: 'Anthropic',
    lines: [
      'Check that your Anthropic API key is saved and active.',
      'Verify the selected Claude model is enabled for your Anthropic account and region.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  openai: {
    label: 'OpenAI',
    lines: [
      'Check that your OpenAI API key is saved and has access to the selected model.',
      'Verify project billing, model permissions, and rate limits in your OpenAI account.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  googleai: {
    label: 'Google AI',
    lines: [
      'Check that your Google AI API key is saved and active.',
      'Verify the selected Gemini model is available for that key and region.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  azureopenai: {
    label: 'Azure OpenAI',
    lines: [
      'Check that Azure OpenAI API key, endpoint, API version, and deployment/model name are saved.',
      'Verify the deployment exists in Azure AI Foundry and the key has access to that resource.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  bedrock: {
    label: 'AWS Bedrock',
    lines: [
      'Check that AWS Access Key ID, Secret Access Key, optional Session Token, and Region are saved.',
      'Verify the IAM principal can call bedrock-runtime:InvokeModel for the selected model and region.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  databricks: {
    label: 'Databricks',
    lines: [
      'Check that your Databricks host/workspace URL and token are saved.',
      'Verify the selected serving endpoint exists and the token can query it.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  custom: {
    label: 'custom OpenAI-compatible provider',
    lines: [
      'Check that base URL, API key, and model name are saved for the custom provider.',
      'Verify the endpoint supports OpenAI-compatible chat completions for the selected model.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  deepseek: {
    label: 'DeepSeek',
    lines: [
      'Check that your DeepSeek API key is saved and active.',
      'Verify the selected DeepSeek model is available and your account has quota.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  dashscope: {
    label: 'DashScope/Qwen',
    lines: [
      'Check that your DashScope API key is saved and active.',
      'Verify the selected Qwen model is available for your account and region.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  zhipu: {
    label: 'Zhipu/GLM',
    lines: [
      'Check that your Zhipu API key is saved and active.',
      'Verify the selected GLM model is enabled and your account has quota.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  moonshot: {
    label: 'Moonshot/Kimi',
    lines: [
      'Check that your Moonshot API key is saved and active.',
      'Verify the selected Kimi model is enabled and your account has quota.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  xai: {
    label: 'xAI',
    lines: [
      'Check that your xAI API key is saved and active.',
      'Verify the selected Grok model is enabled and your account has quota.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
  mistral: {
    label: 'Mistral',
    lines: [
      'Check that your Mistral API key is saved and active.',
      'Verify the selected Mistral model is enabled and your account has quota.',
      'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
    ],
  },
};

export function isBedrockMissingCredentials(data = {}) {
  const haystack = [
    data.message,
    data.error,
    data.code,
    data.phase,
    data.provider,
    data.gateway,
    data.gateway_type,
    data.exception_type,
  ].map(lower).join(' ');

  const mentionsBedrock = haystack.includes('bedrock');
  const mentionsAwsCreds = haystack.includes('aws credentials')
    || haystack.includes('aws credential')
    || haystack.includes('aws_access_key')
    || haystack.includes('aws_secret')
    || haystack.includes('access key')
    || haystack.includes('secret access key');

  return mentionsBedrock && mentionsAwsCreds;
}

export function normalizeGatewayProvider(data = {}) {
  const direct = [
    data.provider,
    data.gateway,
    data.gateway_type,
    data.gatewayType,
  ].map(normalizeProviderToken).find(Boolean);
  if (direct) return direct;

  const haystack = [
    data.message,
    data.error,
    data.code,
    data.phase,
    data.operation,
    data.exception_type,
    data.model,
  ].map(lower).join(' ');

  for (const [alias, provider] of PROVIDER_ALIASES.entries()) {
    if (haystack.includes(alias)) return provider;
  }
  return '';
}

export function formatAgentErrorGuidance(data = {}) {
  const message = compact(data.message || data.error || 'Agent execution failed.');
  const code = compact(data.code);
  const phase = compact(data.phase);
  const provider = normalizeGatewayProvider(data);
  const providerMeta = provider || compact(data.provider || data.gateway || data.gateway_type);
  const taskId = compact(data.task_id);
  const retryAfter = data.retry_after != null ? compact(data.retry_after) : '';
  const retryable = data.retryable === true;

  if (isBedrockMissingCredentials(data)) {
    return {
      title: 'AWS Bedrock credentials are missing.',
      lines: [
        'Kepler reached the Bedrock gateway, but the backend did not receive AWS Access Key ID and Secret Access Key.',
        'Open Kepler/AppStak model settings, re-save the AWS Bedrock provider with Access Key ID, Secret Access Key, and Region, then retry.',
        'If settings were just updated, run /login or restart the CLI so provider settings sync again.',
      ],
      meta: buildMeta({ code, phase, provider: provider || 'bedrock', taskId, retryAfter, retryable }),
    };
  }

  const lines = [];
  const providerGuidance = PROVIDER_GUIDANCE[provider];
  if (phase === 'gateway' || code.includes('gateway')) {
    const label = providerGuidance?.label || 'provider';
    lines.push(`The ${label} gateway failed before the agent could respond.`);
    if (providerGuidance) {
      lines.push(...providerGuidance.lines);
    } else {
      lines.push('Check the selected provider, model, and BYOK credentials in settings, then retry.');
    }
  } else if (/authentication|token/i.test(message)) {
    lines.push('Run /login to re-authenticate.');
  } else if (/api key|openrouter/i.test(message)) {
    lines.push('Run /config to set up or refresh your provider settings.');
  } else if (/backend|network/i.test(message)) {
    lines.push('Check that the backend is reachable, then retry.');
  }

  if (retryable && retryAfter) {
    lines.push(`This looks retryable after ${retryAfter}s.`);
  } else if (retryable) {
    lines.push('This looks retryable.');
  }

  return {
    title: message,
    lines,
    meta: buildMeta({ code, phase, provider: providerMeta, taskId, retryAfter, retryable }),
  };
}

function normalizeProviderToken(value) {
  const raw = lower(value);
  if (!raw) return '';
  const compacted = raw.replace(/[^a-z0-9]/g, '');
  return PROVIDER_ALIASES.get(raw)
    || PROVIDER_ALIASES.get(compacted)
    || '';
}

function buildMeta({ code, phase, provider, taskId, retryAfter, retryable }) {
  const parts = [];
  if (provider) parts.push(`provider=${provider}`);
  if (phase) parts.push(`phase=${phase}`);
  if (code) parts.push(`code=${code}`);
  if (retryable) parts.push(`retryable=true`);
  if (retryAfter) parts.push(`retry_after=${retryAfter}s`);
  if (taskId) parts.push(`task=${taskId}`);
  return parts;
}
