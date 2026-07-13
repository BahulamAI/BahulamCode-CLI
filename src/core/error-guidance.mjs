function compact(value) {
  return String(value || '').trim();
}

function lower(value) {
  return compact(value).toLowerCase();
}

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

export function formatAgentErrorGuidance(data = {}) {
  const message = compact(data.message || data.error || 'Agent execution failed.');
  const code = compact(data.code);
  const phase = compact(data.phase);
  const provider = compact(data.provider || data.gateway || data.gateway_type);
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
  if (phase === 'gateway' || code.includes('gateway')) {
    lines.push('The provider gateway failed before the agent could respond.');
    lines.push('Check the selected provider, model, and BYOK credentials in settings, then retry.');
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
    meta: buildMeta({ code, phase, provider, taskId, retryAfter, retryable }),
  };
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
