import { findShippedModel } from '../config/model-catalog.mjs';

/**
 * Shared client-side context reduction contract.
 *
 * This mirrors the backend context contract so LocalAgent can reduce the
 * same history shape at the same boundary. The transport-specific LLM call
 * is supplied by the caller; this module owns policy and history rewriting.
 */

export const SUMMARY_MARKER = '[Context summary — earlier conversation condensed]';
export const DISTILLATION_MARKER = '[Context distillation — active ingredients preserved]';

const PRODUCT_POLICIES = Object.freeze({
  chat: Object.freeze({ triggerRatio: 0.72, targetRatio: 0.48, preserve: 12, prune: 'aggressive' }),
  ide: Object.freeze({ triggerRatio: 0.78, targetRatio: 0.52, preserve: 10, prune: 'conservative' }),
  workspace: Object.freeze({ triggerRatio: 0.70, targetRatio: 0.45, preserve: 14, prune: 'protected' }),
});

export function contextProduct(product = 'ide') {
  const value = String(product || '').toLowerCase();
  if (value.includes('chat')) return 'chat';
  if (value.includes('workspace')) return 'workspace';
  return 'ide';
}

export function contextPolicy(product = 'ide') {
  return PRODUCT_POLICIES[contextProduct(product)];
}

export function toolPruningPolicy(product = 'ide') {
  const profile = contextProduct(product);
  return {
    profile,
    protected: [
      'write_file', 'edit_file', 'delete_file', 'validate_build',
      'lint_check', 'remember', 'todo_write', 'ask_user',
    ],
    eligible: profile === 'chat'
      ? ['read_file', 'search_code', 'search_files', 'list_files', 'shell']
      : profile === 'workspace'
        ? ['read_file', 'search_code', 'search_files', 'list_files']
        : ['read_file', 'search_code', 'search_files', 'list_files', 'shell'],
  };
}

export function resolveContextBudget({
  product = 'ide', model = null, contextLength = null, maxOutput = null,
  fixedPromptTokens = 0, explicitThreshold = null,
} = {}) {
  const policy = contextPolicy(product);
  const catalog = findShippedModel(model);
  const window = Number(contextLength || catalog?.context_length || 0);
  const output = Number(maxOutput || catalog?.max_output || 0);
  const explicit = Number(explicitThreshold || 0);
  if (explicit > 0) {
    return { ...policy, threshold: Math.max(20_000, Math.floor(explicit)), source: 'explicit' };
  }
  if (!Number.isFinite(window) || window <= 0) {
    return { ...policy, threshold: 160_000, source: 'fallback' };
  }
  const reservedOutput = output > 0 ? output : Math.floor(window * 0.10);
  const safety = Math.max(1024, Math.floor(window * 0.03));
  const usable = Math.max(20_000, window - reservedOutput - Math.max(0, fixedPromptTokens) - safety);
  return {
    ...policy,
    threshold: Math.max(20_000, Math.floor(usable * policy.triggerRatio)),
    targetTokens: Math.max(10_000, Math.floor(usable * policy.targetRatio)),
    contextLength: window,
    reservedOutput,
    fixedPromptTokens: Math.max(0, fixedPromptTokens),
    source: 'model_catalog',
  };
}

export function contextReductionConfig(env = process.env, product = 'ide') {
  const profileName = contextProduct(product).toUpperCase();
  const strategyRaw = String(
    env[`BAHULAM_${profileName}_CONTEXT_STRATEGY`]
      || env.BAHULAM_CONTEXT_STRATEGY
      || env.BAHULAM_CONTEXT_REDUCTION_STRATEGY
      || 'distillation',
  ).trim().toLowerCase();
  const threshold = Number.parseInt(
    env.BAHULAM_SUMMARIZE_THRESHOLD || env.BAHULAM_CHAT_SUMMARIZE_THRESHOLD || '',
    10,
  );
  const preserve = Number.parseInt(
    env.BAHULAM_SUMMARIZE_PRESERVE_TURNS || env.BAHULAM_CHAT_SUMMARIZE_PRESERVE_TURNS || '',
    10,
  );
  const sigma = Number.parseFloat(
    env.BAHULAM_CONTEXT_DISTILLATION_SIGMA || env.BAHULAM_COMPACTION_SIGMA || '1.5',
  );
  return {
    enabled: !['0', 'false', 'no', 'off'].includes(String(env.BAHULAM_SUMMARIZE || 'true').toLowerCase()),
    strategy: ['summary', 'summarize', 'summarization'].includes(strategyRaw)
      ? 'summarization'
      : 'distillation',
    threshold: Number.isFinite(threshold) && threshold > 0 ? Math.max(20_000, threshold) : null,
    preserve: Number.isFinite(preserve) && preserve > 0 ? Math.max(2, preserve) : null,
    sigma: Number.isFinite(sigma) ? Math.max(0.5, Math.min(4, sigma)) : 1.5,
  };
}

export function estimateMessagesTokens(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => {
    let content = message?.content;
    if (typeof content !== 'string') {
      try { content = JSON.stringify(content ?? ''); } catch { content = String(content ?? ''); }
    }
    return total + Math.floor(String(content).length / 4) + 8;
  }, 0);
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(block => block?.text || block?.content || block?.name || '').join(' ');
  }
  try { return JSON.stringify(content ?? ''); } catch { return String(content ?? ''); }
}

function toolNames(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .map(block => block?.name || block?.tool || block?.tool_name)
    .filter(Boolean)
    .map(String)
    .map(name => name.toLowerCase());
}

function scoreMessage(message, index, total, preserve) {
  const pos = total <= 1 ? 1 : index / (total - 1);
  const edgeScore = 2 * ((Math.abs(pos - 0.5) * 2) ** 2);
  const text = messageText(message);
  const tools = toolNames(message);
  let score = edgeScore;
  const reasons = ['position'];
  if (index === 0) { score += 4; reasons.push('root_intent'); }
  if (index >= Math.max(0, total - preserve)) { score += 4; reasons.push('recent_tail'); }
  if (message?.role === 'user') { score += 1.5; reasons.push('user_instruction'); }
  if (tools.some(t => ['write', 'write_file', 'edit', 'edit_file', 'delete_file'].includes(t))) {
    score += 4; reasons.push('durable_write');
  }
  if (tools.some(t => ['read', 'read_file', 'search_code', 'search_files', 'list_files'].includes(t))) {
    score += 1.2; reasons.push('reference');
  }
  if (/(exit[_ -]?code|traceback|error|failed|exception|fatal)/i.test(text)) {
    score += 1.2; reasons.push('failure_signal');
  }
  return { score, reasons, tools, text };
}

export function distillMessages(messages = [], { preserve = 10, sigma = 1.5, maxLines = 180 } = {}) {
  const rows = (Array.isArray(messages) ? messages : []).filter(Boolean);
  if (!rows.length) return null;
  const scored = rows.map((message, index) => scoreMessage(message, index, rows.length, preserve));
  const mean = scored.reduce((sum, row) => sum + row.score, 0) / scored.length;
  const variance = scored.reduce((sum, row) => sum + ((row.score - mean) ** 2), 0) / scored.length;
  const fullThreshold = mean + sigma * Math.sqrt(variance);
  const groups = { full: [], structured: [], distilled: [] };
  scored.forEach((row, index) => {
    const forced = index === 0 || index >= Math.max(0, rows.length - preserve) || row.reasons.includes('durable_write');
    const action = forced || row.score >= fullThreshold
      ? 'full'
      : row.score >= mean ? 'structured' : 'distilled';
    const compact = row.text.replace(/\s+/g, ' ').trim().slice(0, action === 'full' ? 400 : 260);
    groups[action].push(`- ${action}: ${row.tools.length ? `tool=${row.tools.slice(0, 3).join(',')}; ` : ''}${rows[index]?.role || 'message'}: ${compact}`);
  });
  return [
    DISTILLATION_MARKER,
    `policy=context-distillation-v1 sigma=${sigma} counts=${JSON.stringify({ keep_full: groups.full.length, keep_structured: groups.structured.length, distill: groups.distilled.length })}`,
    '', 'Active ingredients kept full:', ...(groups.full.slice(0, maxLines) || ['- none']),
    '', 'Structured middle evidence:', ...(groups.structured.slice(0, maxLines) || ['- none']),
    '', 'Boiled-away noisy trail:', ...(groups.distilled.slice(0, Math.max(12, Math.floor(maxLines / 3))) || ['- none']),
  ].join('\n');
}

export function collapseMessages(messages, summary, preserve = 10) {
  const rows = Array.isArray(messages) ? messages : [];
  const tail = rows.slice(-Math.max(2, preserve));
  return [
    { role: 'user', content: summary },
    { role: 'assistant', content: 'Understood — continuing from the summarized context above.' },
    ...tail,
  ];
}
