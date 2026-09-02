import * as crypto from 'node:crypto';
import { backgroundTasks } from '../core/background-tasks.mjs';
import { normalizeGraphSpec, validateGraph } from './graph.mjs';
import { deriveApprovalScope } from './approval.mjs';
import { runNode } from './node-runner.mjs';
import { graphEvent } from './events.mjs';

/**
 * Execute a graph of agent nodes locally, in-process. Yields the same
 * event vocabulary the main renderer already consumes, plus lifecycle
 * events: graph_run_start, graph_node_start, graph_node_result,
 * graph_run_result.
 *
 * pattern: 'sequential' runs nodes one at a time in topological order.
 * pattern: 'parallel' groups nodes into dependency levels — nodes in the
 * same level (no path between them) execute concurrently; their events
 * are buffered and flushed contiguously in topological order so the
 * output stays deterministic while wall-clock shrinks. Handoffs are
 * snapshotted at level start: same-level nodes never see each other,
 * only completed upstream levels.
 */
export async function* runGraph(graphSpec, triggerInput = {}, ctx = {}, options = {}) {
  const spec = normalizeGraphSpec(graphSpec);
  const agentNodes = validateGraph(spec);
  const runId = options.runId || `gr-${crypto.randomUUID().slice(0, 12)}`;

  const resolveAgent = ctx.resolveAgent || (() => null);
  for (const node of agentNodes) {
    if (node.type === 'job' || node.type === 'service') continue;
    if (!node.agent) node.agent = resolveAgent(node.agent_slug);
    if (!node.agent) throw new Error(`Unknown agent '${node.agent_slug}' in graph '${spec.name}'`);
  }

  const approvalScope = deriveApprovalScope(agentNodes, resolveAgent);
  yield graphEvent('graph_run_start', runId, {
    graph: spec.name,
    pattern: spec.pattern,
    node_count: agentNodes.length,
    approval_scope: approvalScope,
  });

  const levels = spec.pattern === 'parallel'
    ? dependencyLevels(agentNodes, spec.edges)
    : agentNodes.map(node => [node]);

  const nodeResults = [];
  const handoffs = [];
  let status = 'completed';
  // Service nodes register their process here; the run is their lifetime
  // scope — everything still running is killed when the graph ends,
  // whatever path it ends by (finally covers errors and early consumer
  // abandonment too).
  const serviceJobs = [];
  const nodeOptions = { ...options, runId, serviceJobs };

  try {
  for (const level of levels) {
    if (status === 'failed') break;
    const levelHandoffs = [...handoffs];

    for (const node of level) {
      yield graphEvent('graph_node_start', runId, {
        node_id: node.id,
        agent: node.agent_slug || node.id,
        parallel_group: level.length > 1 ? level.map(n => n.id) : undefined,
      });
    }

    // Solo level: stream events live (no buffering) — this is the /run
    // and sequential-pattern hot path.
    if (level.length === 1) {
      const node = level[0];
      const instruction = buildNodeInstruction(node, triggerInput, levelHandoffs, spec.global_params);
      let output = '';
      let accumulated = '';
      let nodeStatus = 'completed';
      try {
        for await (const event of runNode(node, node.agent, instruction, ctx, nodeOptions)) {
          if (event.type === 'content' || event.type === 'content_partial') {
            accumulated += event.data?.text || event.data?.content || '';
          }
          if (event.type === 'complete' && typeof event.data?.final_response === 'string') {
            output = event.data.final_response;
          }
          yield event;
        }
      } catch (err) {
        nodeStatus = 'failed';
        output = err?.message || String(err);
      }
      if (!output && nodeStatus === 'completed') output = accumulated;
      const result = { node_id: node.id, agent: node.agent_slug || node.id, status: nodeStatus, output };
      nodeResults.push(result);
      yield graphEvent('graph_node_result', runId, result);
      if (result.status === 'failed' && !node.continue_on_error) {
        status = 'failed';
      } else if (result.status === 'completed' && result.output) {
        handoffs.push({ node_id: result.node_id, agent: result.agent, output: result.output });
      }
      continue;
    }

    // Parallel level: start every node concurrently; drain buffers in
    // topological order so events stay contiguous per node.
    const runs = level.map(node => collectNodeRun(
      node,
      buildNodeInstruction(node, triggerInput, levelHandoffs, spec.global_params),
      ctx,
      nodeOptions,
    ));

    for (let i = 0; i < level.length; i++) {
      const { events, result } = await runs[i];
      for (const event of events) yield event;
      nodeResults.push(result);
      yield graphEvent('graph_node_result', runId, result);
      if (result.status === 'failed' && !level[i].continue_on_error) {
        status = 'failed';
      } else if (result.status === 'completed' && result.output) {
        handoffs.push({ node_id: result.node_id, agent: result.agent, output: result.output });
      }
    }
  }

  } finally {
    for (const id of serviceJobs) {
      try { backgroundTasks.kill(id); } catch { /* already gone */ }
    }
  }

  const result = {
    run_id: runId,
    graph: spec.name,
    status,
    node_results: nodeResults,
    output: nodeResults.length ? nodeResults[nodeResults.length - 1].output : '',
  };
  yield graphEvent('graph_run_result', runId, result);
  return result;
}

async function collectNodeRun(node, instruction, ctx, options) {
  const events = [];
  let output = '';
  let accumulated = '';
  let nodeStatus = 'completed';
  try {
    for await (const event of runNode(node, node.agent, instruction, ctx, options)) {
      if (event.type === 'content' || event.type === 'content_partial') {
        accumulated += event.data?.text || event.data?.content || '';
      }
      if (event.type === 'complete' && typeof event.data?.final_response === 'string') {
        output = event.data.final_response;
      }
      events.push(event);
    }
  } catch (err) {
    nodeStatus = 'failed';
    output = err?.message || String(err);
  }
  if (!output && nodeStatus === 'completed') output = accumulated;
  return {
    events,
    result: { node_id: node.id, agent: node.agent_slug || node.id, status: nodeStatus, output },
  };
}

// Group agent nodes by dependency depth: level N nodes depend only on
// nodes in levels < N. agentNodes arrive topologically ordered, so each
// node's predecessors are resolved before it.
function dependencyLevels(agentNodes, edges) {
  const ids = new Set(agentNodes.map(node => node.id));
  const preds = new Map(agentNodes.map(node => [node.id, []]));
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) preds.get(edge.target).push(edge.source);
  }
  const depth = new Map();
  const levels = [];
  for (const node of agentNodes) {
    const upstream = preds.get(node.id);
    const d = upstream.length ? 1 + Math.max(...upstream.map(id => depth.get(id) ?? 0)) : 0;
    depth.set(node.id, d);
    (levels[d] ||= []).push(node);
  }
  return levels;
}

function buildNodeInstruction(node, triggerInput, handoffs, globalParams) {
  const parts = [node.prompt || triggerInput.instruction || ''];
  if (globalParams && Object.keys(globalParams).length) {
    parts.push(`Parameters:\n${JSON.stringify(globalParams, null, 2)}`);
  }
  if (handoffs.length) {
    const upstream = handoffs
      .map(h => `--- handoff from ${h.agent} ---\n${h.output}`)
      .join('\n\n');
    parts.push(`Results from earlier steps:\n\n${upstream}`);
  }
  return parts.filter(Boolean).join('\n\n');
}
