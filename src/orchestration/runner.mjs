import * as crypto from 'node:crypto';
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
 * Nodes execute sequentially in topological order. Each node's
 * instruction is its declared prompt (or the trigger instruction),
 * followed by the handoffs of completed upstream nodes so results flow
 * along the edges.
 */
export async function* runGraph(graphSpec, triggerInput = {}, ctx = {}, options = {}) {
  const spec = normalizeGraphSpec(graphSpec);
  const agentNodes = validateGraph(spec);
  const runId = options.runId || `gr-${crypto.randomUUID().slice(0, 12)}`;

  const resolveAgent = ctx.resolveAgent || (() => null);
  for (const node of agentNodes) {
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

  const nodeResults = [];
  const handoffs = [];
  let status = 'completed';

  for (const node of agentNodes) {
    yield graphEvent('graph_node_start', runId, { node_id: node.id, agent: node.agent_slug || node.id });
    const instruction = buildNodeInstruction(node, triggerInput, handoffs, spec.global_params);
    let output = '';
    let nodeStatus = 'completed';
    try {
      let accumulated = '';
      for await (const event of runNode(node, node.agent, instruction, ctx, { ...options, runId })) {
        if (event.type === 'content' || event.type === 'content_partial') {
          accumulated += event.data?.text || event.data?.content || '';
        }
        if (event.type === 'complete' && typeof event.data?.final_response === 'string') {
          output = event.data.final_response;
        }
        yield event;
      }
      if (!output) output = accumulated;
    } catch (err) {
      nodeStatus = 'failed';
      output = err?.message || String(err);
    }
    nodeResults.push({ node_id: node.id, agent: node.agent_slug || node.id, status: nodeStatus, output });
    yield graphEvent('graph_node_result', runId, nodeResults[nodeResults.length - 1]);

    if (nodeStatus === 'failed' && !node.continue_on_error) {
      status = 'failed';
      break;
    }
    if (nodeStatus === 'completed' && output) {
      handoffs.push({ node_id: node.id, agent: node.agent_slug || node.id, output });
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
