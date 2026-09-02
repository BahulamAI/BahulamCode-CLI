/**
 * GraphSpec — the one shape every runnable compiles to.
 *
 * A deterministic sub-agent run is a one-node graph (trigger → agent →
 * output); a multi-agent workflow is the same graph with N agent nodes.
 * Inputs accepted: an inline GraphSpec, a multi-workflow loader payload
 * ({ graph: { nodes, edges } }), or a single agent definition via
 * compileSingleAgentGraph().
 */

export function compileSingleAgentGraph(agent, { instruction = '' } = {}) {
  const slug = agent.slug || agent.name;
  return {
    name: slug,
    channel: 'local',
    pattern: 'sequential',
    nodes: [
      { id: 'trigger', type: 'trigger' },
      { id: slug, type: 'agent', agent_slug: slug, agent, prompt: instruction },
      { id: 'output', type: 'output' },
    ],
    edges: [
      { source: 'trigger', target: slug },
      { source: slug, target: 'output' },
    ],
    global_params: {},
  };
}

export function normalizeGraphSpec(input) {
  if (!input || typeof input !== 'object') throw new Error('Graph spec is required');
  // Multi-workflow loader payload: { name, graph: { nodes, edges }, ... }
  const source = input.graph && Array.isArray(input.graph.nodes) ? input.graph : input;
  const nodes = (source.nodes || []).map(node => ({
    id: node.id,
    type: node.type,
    agent_slug: node.agent_slug || node.data?.agent_slug || node.data?.user_agent_slug || null,
    agent: node.agent || null,
    prompt: node.prompt || node.data?.prompt || '',
    model: normalizeModel(node.model ?? node.data?.model),
    tools: Array.isArray(node.tools) ? node.tools : (Array.isArray(node.data?.tools) ? node.data.tools : []),
    config: node.config || node.data?.config || {},
    continue_on_error: Boolean(node.continue_on_error),
    // job nodes: a process instead of an LLM
    command: node.command || node.data?.command || null,
    timeout_s: Number(node.timeout_s ?? node.data?.timeout_s) || null,
    // service nodes: long-lived process (dev server); the node completes
    // at READINESS, the process lives until the graph run ends.
    ready: node.ready || node.data?.ready || null,
  }));
  const edges = (source.edges || []).map(edge => ({ source: edge.source, target: edge.target }));
  return {
    name: input.name || source.name || 'graph',
    channel: input.channel || 'local',
    pattern: input.pattern || input.orchestration_pattern || 'sequential',
    nodes,
    edges,
    global_params: input.global_params || {},
  };
}

function normalizeModel(value) {
  const model = String(value || '').trim();
  return !model || model === 'auto' ? null : model;
}

/**
 * Validate the graph and return executable nodes (type 'agent' or 'job')
 * in execution (topological) order. Throws before any LLM call on:
 * unknown edge endpoints, cycles, unreachable nodes, agent nodes with no
 * definition reference, or job nodes with no command.
 */
export function validateGraph(spec) {
  const byId = new Map(spec.nodes.map(node => [node.id, node]));
  for (const edge of spec.edges) {
    if (!byId.has(edge.source)) throw new Error(`Edge references unknown node '${edge.source}'`);
    if (!byId.has(edge.target)) throw new Error(`Edge references unknown node '${edge.target}'`);
  }
  const outgoing = new Map(spec.nodes.map(node => [node.id, []]));
  const indegree = new Map(spec.nodes.map(node => [node.id, 0]));
  for (const edge of spec.edges) {
    outgoing.get(edge.source).push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target) + 1);
  }

  // Kahn topological sort — leftover nodes mean a cycle.
  const queue = spec.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of outgoing.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== spec.nodes.length) {
    throw new Error(`Graph '${spec.name}' contains a cycle`);
  }

  const reachable = new Set();
  const stack = spec.nodes.filter(node => node.type === 'trigger').map(node => node.id);
  while (stack.length) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    stack.push(...outgoing.get(id));
  }

  const executableNodes = order
    .map(id => byId.get(id))
    .filter(node => node.type === 'agent' || node.type === 'job' || node.type === 'service');
  if (!executableNodes.length) throw new Error(`Graph '${spec.name}' has no agent, job, or service nodes`);
  for (const node of executableNodes) {
    if (!reachable.has(node.id)) {
      throw new Error(`Node '${node.id}' is not reachable from the trigger`);
    }
    if (node.type === 'agent' && !node.agent && !node.agent_slug) {
      throw new Error(`Agent node '${node.id}' has neither an inline agent nor an agent_slug`);
    }
    if ((node.type === 'job' || node.type === 'service') && !String(node.command || '').trim()) {
      throw new Error(`${node.type === 'job' ? 'Job' : 'Service'} node '${node.id}' has no command`);
    }
  }
  return executableNodes;
}
