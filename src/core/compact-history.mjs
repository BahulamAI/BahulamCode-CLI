const SUMMARY_PREFIX = 'Session continuity summary after /compact:';

export function parseCompactTailCount(rest = '', fallback = 8) {
  const text = String(rest || '').trim();
  const match = text.match(/(?:^|\s)(?:--tail=|--tail\s+)?(\d+)(?:\s|$)/);
  const n = match ? Number(match[1]) : Number(fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(2, Math.min(50, Math.floor(n)));
}

export function isCompactHistory(history = []) {
  return typeof history?.[2]?.content === 'string'
    && history[2].content.startsWith(SUMMARY_PREFIX);
}

export function extractCompactSummary(history = []) {
  const content = String(history?.[2]?.content || '');
  if (!content.startsWith(SUMMARY_PREFIX)) return '';
  return content.slice(SUMMARY_PREFIX.length).trim();
}

export function prepareCompactHistory({
  agentHistory = [],
  tailCount = 8,
  minSourceMessages = 2,
} = {}) {
  const history = Array.isArray(agentHistory)
    ? agentHistory.filter(msg => msg && typeof msg.content === 'string' && msg.content.trim())
    : [];
  const beforeCount = history.length;
  const retainedCount = Math.min(Math.max(2, Number(tailCount) || 8), Math.max(0, beforeCount));
  const prefixCount = isCompactHistory(history) ? 3 : 0;
  const sourceEnd = Math.max(prefixCount, beforeCount - retainedCount);
  const sourceMessages = history.slice(prefixCount, sourceEnd);
  const tail = history.slice(sourceEnd);

  if (sourceMessages.length < minSourceMessages) {
    return {
      ok: false,
      reason: beforeCount <= prefixCount + retainedCount
        ? 'not enough history beyond the retained tail'
        : 'not enough compactable messages',
      beforeCount,
      prefixCount,
      sourceMessages,
      tail,
      retainedCount,
    };
  }

  return {
    ok: true,
    beforeCount,
    prefixCount,
    sourceMessages,
    tail,
    retainedCount: tail.length,
    previousSummary: extractCompactSummary(history),
  };
}

export function applyCompactSummary({
  prepared,
  summary,
  sessionId = '',
  cwd = '',
  originalRequest = '',
  previousSourceMessageCount = 0,
  now = new Date(),
} = {}) {
  if (!prepared?.ok) throw new Error(prepared?.reason || 'history is not compactable');
  const compactSummary = String(summary || '').trim();
  if (!compactSummary) throw new Error('summary is required');
  const priorCount = Math.max(0, Number(previousSourceMessageCount) || 0);
  const sourceMessageCount = priorCount + prepared.sourceMessages.length;
  const timestamp = now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
  const firstUser = originalRequest || firstUserMessage(prepared.sourceMessages) || firstUserMessage(prepared.tail) || '(unknown)';

  const metadata = [
    'Compact metadata.',
    sessionId ? `Session: ${sessionId}` : '',
    cwd ? `Project: ${cwd}` : '',
    `Compacted at: ${timestamp}`,
    `Covered live messages: ${sourceMessageCount}`,
    `Retained tail messages: ${prepared.tail.length}`,
  ].filter(Boolean).join('\n');

  const agentHistory = [
    { role: 'user', content: metadata },
    { role: 'user', content: `Original user request from this compacted session:\n${firstUser}` },
    { role: 'user', content: `${SUMMARY_PREFIX}\n${compactSummary}` },
    ...prepared.tail,
  ];

  return {
    agentHistory,
    summary: compactSummary,
    sourceMessageCount,
    previousSourceMessageCount: priorCount,
    beforeCount: prepared.beforeCount,
    afterCount: agentHistory.length,
    retainedCount: prepared.tail.length,
    compactedCount: prepared.sourceMessages.length,
  };
}

export function localCompactSummary(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const userMessages = list.filter(m => m.role === 'user').map(m => String(m.content || '').trim()).filter(Boolean);
  const assistantMessages = list.filter(m => m.role === 'assistant').map(m => String(m.content || '').trim()).filter(Boolean);
  return [
    'Local compact summary from live conversation context.',
    userMessages.length ? `User requests (${userMessages.length}):` : '',
    ...userMessages.slice(-8).map(text => `- ${truncate(text, 500)}`),
    assistantMessages.length ? `Assistant progress (${assistantMessages.length}):` : '',
    ...assistantMessages.slice(-8).map(text => `- ${truncate(text, 700)}`),
  ].filter(Boolean).join('\n');
}

function firstUserMessage(messages = []) {
  return messages.find(m => m?.role === 'user' && typeof m.content === 'string')?.content || '';
}

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 3) + '...' : value;
}
