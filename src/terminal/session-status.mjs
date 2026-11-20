import { contextReductionConfig, resolveContextBudget } from '../core/context-reduction.mjs';
import { formatTokens } from '../core/pricing.mjs';
import { rustSessionUsage } from '../daemon/rust-tui-snapshot.mjs';

export async function fetchMessageWindows({ backendUrl, token }, fetchImpl = fetch) {
  if (!backendUrl || !token) return null;
  try {
    const response = await fetchImpl(backendUrl + '/api/cli/message-windows', {
      headers: { Authorization: 'Bearer ' + token, 'X-Product': 'bahulam' },
      signal: AbortSignal.timeout(2500),
    });
    if (response.ok) {
      const state = await response.json();
      if (state?.windows && state.usage_available !== false) return state;
    }
  } catch { /* Offline or running an older backend. */ }
  return null;
}

export function contextStatusRows(session, runtimeMode) {
  const usage = rustSessionUsage(session);
  const activeModel = session.model || session.modelLimits?.coder?.model;
  const coder = session.modelLimits?.coder;
  const limits = coder?.model === activeModel ? coder : undefined;
  const localPolicy = runtimeMode === 'direct' || runtimeMode === 'local';
  const config = contextReductionConfig();
  const budget = resolveContextBudget({
    model: activeModel, contextLength: limits?.context_length,
    maxOutput: limits?.max_output, explicitThreshold: localPolicy ? config.threshold : null,
  });
  const rows = [
    ['Model window', budget.contextLength ? formatTokens(budget.contextLength) + ' tokens' : 'Unknown for current model'],
    ['Local history', '≈' + formatTokens(usage.context_tokens) + ' tokens'],
    ['Last request', session.lastTurnInputTokens > 0 ? formatTokens(session.lastTurnInputTokens) + ' input tokens' : 'No usage reported'],
    ['Session total', formatTokens(usage.input_tokens) + ' input · ' + formatTokens(usage.output_tokens) + ' output'],
    ['Summary trigger', localPolicy && !config.enabled ? 'Disabled for this runtime'
      : '≈' + formatTokens(budget.threshold) + (budget.source === 'fallback' ? ' tokens (fallback estimate)' : ' history tokens (before prompt overhead)')],
  ];
  if (session.summaryProgress) rows.push(['Latest attempt', session.summaryProgress]);
  const summary = session.lastContextSummary;
  if (summary) {
    const parts = [summary.strategy || 'summarized'];
    if (Number.isFinite(summary.collapsed_messages)) parts.push(summary.collapsed_messages + ' messages condensed');
    if (Number.isFinite(summary.kept_recent)) parts.push(summary.kept_recent + ' recent kept');
    if (summary.threshold > 0) parts.push('trigger ' + formatTokens(summary.threshold) + ' tokens');
    rows.push(['Last reduction', parts.join(' · ')]);
  } else {
    rows.push(['Last reduction', 'No completed reduction recorded']);
  }
  if (session.resumeSummaryCount > 0) rows.push(['Resume checkpoint', session.resumeSummaryCount + ' messages covered']);
  return rows;
}
