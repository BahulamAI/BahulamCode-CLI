import { LocalAgent } from '../core/local-agent.mjs';
import { createScopedToolExecutor } from '../terminal/agents.mjs';
import { namespaceNodeEvents } from './events.mjs';

/**
 * Execute one agent node. Substrates:
 *   'direct'  — a per-node LocalAgent instance calling the model API
 *               directly. One instance per node makes the node's resolved
 *               model deterministic (LocalAgent fixes model at construction).
 *   'session' — an injected adapter (ctx.sessionSubstrate) that runs the
 *               node through the logged-in backend flow. The engine stays
 *               terminal-agnostic; the REPL provides the adapter.
 *
 * Every tool call flows through a scoped executor that enforces the
 * node's effective allowlist and tags calls internal/subAgent, so hooks,
 * plugin-tool gating, and attribution behave exactly like direct agent
 * runs today.
 */
export async function* runNode(node, agent, instruction, ctx, options = {}) {
  const effectiveAgent = withEffectiveTools(node, agent);
  const scopedExecutor = createScopedToolExecutor(ctx.toolExecutor, effectiveAgent, {
    projectRoot: ctx.cwd || process.cwd(),
  });
  const substrate = selectSubstrate(ctx, options);

  if (substrate === 'session') {
    yield* namespaceNodeEvents(
      ctx.sessionSubstrate(effectiveAgent, node, instruction, { scopedExecutor }),
      { node, runId: options.runId },
    );
    return;
  }

  const model = node.model || effectiveAgent.model || ctx.defaultModel || null;
  const { apiKey = null, openRouterKey = null } = ctx.credentials || {};
  if (!apiKey && !openRouterKey) {
    throw new Error(
      `Cannot run node '${node.id}' locally: no model API key. ` +
      'Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, or log in and use the session substrate.',
    );
  }

  const localAgent = new LocalAgent({
    apiKey,
    openRouterKey,
    model,
    toolExecutor: scopedExecutor,
    cwd: ctx.cwd || process.cwd(),
    systemPromptOverride: effectiveAgent.prompt || effectiveAgent.system_prompt || null,
    maxTurns: effectiveAgent.max_iterations || null,
  });
  if (options.signal) options.signal.addEventListener('abort', () => localAgent.cancel?.(), { once: true });

  yield* namespaceNodeEvents(localAgent.execute(instruction, {}), { node, runId: options.runId });
}

function selectSubstrate(ctx, options) {
  const requested = options.substrate || 'auto';
  if (requested === 'session' || requested === 'direct') return requested;
  return typeof ctx.sessionSubstrate === 'function' && ctx.auth?.token ? 'session' : 'direct';
}

// node.tools, when present, narrows the agent's own allowlist (intersection).
function withEffectiveTools(node, agent) {
  const agentTools = Array.isArray(agent.tools) ? agent.tools : [];
  if (!Array.isArray(node.tools) || !node.tools.length) return agent;
  const narrowed = new Set(node.tools);
  return { ...agent, tools: agentTools.filter(tool => narrowed.has(tool)) };
}
