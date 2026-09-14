import { runGraph } from './runner.mjs';
import { compileSingleAgentGraph, normalizeGraphSpec } from './graph.mjs';

const MAX_CHAIN_DEPTH = 3;

/**
 * The single funnel for deterministic runs. Every surface (CLI, /run,
 * headless, hooks, cron, daemon, programmatic) builds a TriggerEvent and
 * calls dispatch(); nothing else calls runGraph() directly.
 *
 * TriggerEvent: {
 *   type: 'invoke'|'manual'|'hook'|'prompt_match'|'cron'|'remote',
 *   source: string,                     // e.g. 'cli:agent-run', 'hook:Stop'
 *   target: {kind:'agent'|'workflow', slug} | string,  // bare names resolved below
 *   params: { instruction, ... },
 *   channel: 'local'|'server'|null,     // null → derived from the target
 *   initiator: { chain: string[] } | null,
 * }
 */
export async function dispatch(event, ctx) {
  const chain = event.initiator?.chain || [];
  if (chain.length >= MAX_CHAIN_DEPTH) {
    return { dispatched: false, reason: `Trigger chain depth limit (${MAX_CHAIN_DEPTH}) reached` };
  }

  const resolved = resolveTarget(event.target, ctx);
  if (!resolved) {
    return { dispatched: false, reason: `Unknown target '${targetName(event.target)}'` };
  }
  if (chain.includes(resolved.key)) {
    return { dispatched: false, reason: `Trigger cycle detected at '${resolved.key}'` };
  }

  const channel = event.channel || resolved.channel;
  if (channel === 'server') {
    // Synced server workflows keep their exact existing execution path.
    const result = await ctx.toolExecutor.execute('workflow_run_multi', {
      name: resolved.slug,
      instruction: event.params?.instruction || '',
    });
    return { dispatched: true, channel, result };
  }

  const graph = resolved.kind === 'agent'
    ? compileSingleAgentGraph(resolved.agent, { instruction: event.params?.instruction || '' })
    : resolved.graph;

  const runCtx = { ...ctx, resolveAgent: slug => resolveAgentBySlug(slug, ctx) };
  const iterator = runGraph(graph, { instruction: event.params?.instruction || '', params: event.params || {} }, runCtx, {
    substrate: event.substrate,
    signal: event.signal,
  });

  let result = null;
  while (true) {
    const { value, done } = await iterator.next();
    if (done) { result = value; break; }
    ctx.renderEvent?.(value);
  }
  return { dispatched: true, channel: 'local', result };
}

function targetName(target) {
  return typeof target === 'string' ? target : `${target?.kind}:${target?.slug}`;
}

function resolveAgentBySlug(slug, ctx) {
  return (ctx.listRunnables?.() || []).find(agent => agent.slug === slug) || null;
}

/**
 * Bare-name resolution order (uniform across surfaces, preserves today's
 * /run behavior): project agent → global agent → platform → allowlisted
 * plugin agent → local workflow → synced server workflow fallback.
 * listRunnables() already returns agents deduped in that precedence.
 */
function resolveTarget(target, ctx) {
  const raw = typeof target === 'string' ? String(target || '').trim() : '';
  const prefixed = raw.match(/^(agent|workflow):(.+)$/);
  const typed = typeof target === 'object' && target?.kind
    ? target
    : prefixed
      ? { kind: prefixed[1], slug: prefixed[2].trim() }
      : null;
  const name = typed ? typed.slug : raw;
  if (!name) return null;

  if (typed?.kind === 'agent' && typed.agent) {
    // Caller already resolved the full definition (prompt, readOnly, tools).
    return { kind: 'agent', slug: name, key: `agent:${name}`, agent: typed.agent, channel: 'local' };
  }
  if (!typed || typed.kind === 'agent') {
    const agent = resolveAgentBySlug(name, ctx);
    if (agent) return { kind: 'agent', slug: name, key: `agent:${name}`, agent, channel: 'local' };
    if (typed) return null;
  }

  const workflows = ctx.listLocalWorkflows?.() || [];
  const workflow = workflows.find(w => w.slug === name || w.name === name);
  if (workflow) {
    // Channel comes from the file: v2 files run locally; v1 files (no
    // apiVersion) keep today's server execution so nothing silently flips.
    const isV2 = /\/2$/.test(String(workflow.api_version || workflow.apiVersion || ''));
    return {
      kind: 'workflow',
      slug: workflow.slug || name,
      key: `workflow:${name}`,
      graph: isV2 ? normalizeGraphSpec(workflow) : null,
      channel: isV2 ? 'local' : 'server',
    };
  }

  if (!typed || typed.kind === 'workflow') {
    // Name may exist only as a synced server workflow — let the server path try.
    return { kind: 'workflow', slug: name, key: `workflow:${name}`, graph: null, channel: 'server' };
  }
  return null;
}
