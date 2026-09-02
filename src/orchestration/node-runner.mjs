import { LocalAgent } from '../core/local-agent.mjs';
import { backgroundTasks } from '../core/background-tasks.mjs';
import { classifyShell, TIERS } from '../core/risk-tier.mjs';
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
  if (node.type === 'job') {
    yield* namespaceNodeEvents(runJobNode(node, ctx, options), { node, runId: options.runId });
    return;
  }
  if (node.type === 'service') {
    yield* namespaceNodeEvents(runServiceNode(node, ctx, options), { node, runId: options.runId });
    return;
  }
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

// A job node runs a process instead of an LLM. It blocks its graph edge
// until the process exits (graph-level parallelism provides concurrency),
// and its handoff is the exit code plus the output tail. Commands are
// risk-classified up front — dangerous patterns fail the node
// deterministically rather than prompting mid-graph.
async function* runJobNode(node, ctx, options = {}) {
  const command = String(node.command || '').trim();
  const tier = classifyShell(command);
  if (tier === TIERS.SHELL_DANGEROUS) {
    throw new Error(`Job '${node.id}' blocked: command matches a high-risk pattern (${command.slice(0, 80)})`);
  }

  const started = backgroundTasks.start({
    command,
    cwd: ctx.cwd || process.cwd(),
    timeoutMs: node.timeout_s ? node.timeout_s * 1000 : undefined,
    name: node.id,
  });
  yield { type: 'status', data: { message: `job ${node.id}: ${command.slice(0, 80)} (${started.id})` } };
  if (options.signal) {
    options.signal.addEventListener('abort', () => backgroundTasks.kill(started.id), { once: true });
  }

  const done = await backgroundTasks.wait(started.id);
  const ok = done.status === 'completed';
  const summaryLine = `job ${node.id} ${done.status} (exit ${done.exit_code ?? 'n/a'}, ${done.duration_s}s)`;
  const tail = String(done.tail || '').trim();
  if (!ok) {
    throw new Error(`${summaryLine}${tail ? `\n${tail.slice(-2000)}` : ''}`);
  }
  yield {
    type: 'complete',
    data: {
      final_response: `${summaryLine}${tail ? `\n${tail}` : ''}`,
      job_id: done.id,
      exit_code: done.exit_code,
      log_path: done.log_path,
    },
  };
}

// A service node starts a long-lived process (dev server) and completes
// at READINESS, not exit — downstream nodes run against the live service.
// The process is registered in options.serviceJobs so the graph runner
// kills it when the run ends. Readiness: ready.port (TCP connect),
// ready.log_pattern (regex on output tail), or ready.delay_s (default 2s).
async function* runServiceNode(node, ctx, options = {}) {
  const command = String(node.command || '').trim();
  const tier = classifyShell(command);
  if (tier === TIERS.SHELL_DANGEROUS) {
    throw new Error(`Service '${node.id}' blocked: command matches a high-risk pattern (${command.slice(0, 80)})`);
  }

  const started = backgroundTasks.start({
    command,
    cwd: ctx.cwd || process.cwd(),
    timeoutMs: 0, // services live until the graph run ends
    name: node.id,
  });
  if (Array.isArray(options.serviceJobs)) options.serviceJobs.push(started.id);
  yield { type: 'status', data: { message: `service ${node.id}: ${command.slice(0, 80)} (${started.id})` } };

  const ready = node.ready || {};
  const timeoutMs = (Number(ready.timeout_s) || 60) * 1000;
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const job = backgroundTasks.describe(started.id);
    if (!job || job.status !== 'running') {
      throw new Error(`service ${node.id} exited before becoming ready (${job?.status}, exit ${job?.exit_code})\n${String(job?.tail || '').slice(-1000)}`);
    }
    if (ready.port) return await portOpen(Number(ready.port));
    if (ready.log_pattern) return new RegExp(ready.log_pattern).test(job.tail || '');
    return true; // no probe declared → ready after the initial delay
  };

  await new Promise(resolve => setTimeout(resolve, (Number(ready.delay_s) || 2) * 1000));
  while (!(await poll())) {
    if (Date.now() > deadline) {
      backgroundTasks.kill(started.id);
      throw new Error(`service ${node.id} not ready within ${timeoutMs / 1000}s`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  yield {
    type: 'complete',
    data: {
      final_response: `service ${node.id} ready (${started.id}${ready.port ? `, port ${ready.port}` : ''}). It stays up for the rest of this run.`,
      job_id: started.id,
    },
  };
}

async function portOpen(port) {
  const { Socket } = await import('node:net');
  return new Promise(resolve => {
    const socket = new Socket();
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(750, () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1', () => done(true));
  });
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
