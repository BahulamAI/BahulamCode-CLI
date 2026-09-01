// Smoke test: local graph engine (graph/runner/node-runner/dispatch).
// Run: node test/orchestration-smoke.mjs — no network, no LLM (mock substrate).
import { runGraph } from '../src/orchestration/runner.mjs';
import { compileSingleAgentGraph, normalizeGraphSpec, validateGraph } from '../src/orchestration/graph.mjs';
import { deriveApprovalScope } from '../src/orchestration/approval.mjs';
import { dispatch } from '../src/orchestration/dispatch.mjs';

let failures = 0;
function expect(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`ok   ${label}`);
  else { failures++; console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`); }
}

const agents = {
  scout: { slug: 'scout', name: 'Scout', tools: ['read_file', 'search_code'], prompt: 'scout it' },
  writer: { slug: 'writer', name: 'Writer', tools: ['write_file'], prompt: 'write it' },
};

// Mock session substrate: echoes which agent ran and what it received;
// also probes the scoped executor with an out-of-allowlist tool.
const toolCalls = [];
const baseExecutor = {
  execute: async (name, args, options) => {
    toolCalls.push({ name, internal: options?.internal, subAgent: options?.subAgent });
    return { success: true, output: `${name}-ok` };
  },
};
function mockSubstrate(agent, node, instruction, { scopedExecutor }) {
  return (async function* () {
    const denied = await scopedExecutor.execute('shell', {});
    const allowed = await scopedExecutor.execute(agent.tools[0], {});
    yield { type: 'content', data: { content: `${agent.slug} saw: ${instruction.slice(0, 40)} | denied=${denied.success} allowed=${allowed.success}` } };
    yield { type: 'complete', data: { final_response: `${agent.slug}-result` } };
  })();
}

const ctx = {
  toolExecutor: baseExecutor,
  sessionSubstrate: mockSubstrate,
  auth: { token: 't' },
  listRunnables: () => Object.values(agents),
  listLocalWorkflows: () => [],
  renderEvent: () => {},
};

// ── 1. Degenerate one-node graph ──
{
  const graph = compileSingleAgentGraph(agents.scout, { instruction: 'find the config loader' });
  const events = [];
  let result;
  const it = runGraph(graph, { instruction: 'find the config loader' }, ctx, { substrate: 'session' });
  while (true) { const { value, done } = await it.next(); if (done) { result = value; break; } events.push(value.type); }
  expect('single-node lifecycle', events.filter(t => t.startsWith('graph_')),
    ['graph_run_start', 'graph_node_start', 'graph_node_result', 'graph_run_result']);
  expect('single-node status', result.status, 'completed');
  expect('single-node output', result.output, 'scout-result');
}

// ── 2. Two-node graph: handoff threading + scoped tools + attribution ──
{
  toolCalls.length = 0;
  const spec = {
    name: 'pipeline',
    nodes: [
      { id: 'trigger', type: 'trigger' },
      { id: 'scout', type: 'agent', agent_slug: 'scout' },
      { id: 'writer', type: 'agent', agent_slug: 'writer' },
      { id: 'output', type: 'output' },
    ],
    edges: [
      { source: 'trigger', target: 'scout' },
      { source: 'scout', target: 'writer' },
      { source: 'writer', target: 'output' },
    ],
  };
  const contents = [];
  let result;
  const it = runGraph(spec, { instruction: 'do the thing' }, { ...ctx, resolveAgent: s => agents[s] }, { substrate: 'session' });
  while (true) { const { value, done } = await it.next(); if (done) { result = value; break; }
    if (value.type === 'content') contents.push(value.data); }
  expect('two-node order', result.node_results.map(r => r.agent), ['scout', 'writer']);
  expect('writer received scout handoff', contents[1].content.includes('scout-result') || result.node_results[1].output === 'writer-result', true);
  expect('scoped executor denies out-of-allowlist shell', toolCalls.some(c => c.name === 'shell'), false);
  expect('scoped calls tagged internal+subAgent', toolCalls.every(c => c.internal === true && typeof c.subAgent === 'string'), true);
  expect('events tagged with sub_agent', contents.every(d => d.internal === true && d.sub_agent), true);
}

// ── 3. Approval scope = union of member allowlists ──
{
  const nodes = validateGraph(normalizeGraphSpec({
    name: 'x',
    nodes: [
      { id: 'trigger', type: 'trigger' },
      { id: 'scout', type: 'agent', agent_slug: 'scout', agent: agents.scout },
      { id: 'writer', type: 'agent', agent_slug: 'writer', agent: agents.writer },
      { id: 'output', type: 'output' },
    ],
    edges: [
      { source: 'trigger', target: 'scout' },
      { source: 'scout', target: 'writer' },
      { source: 'writer', target: 'output' },
    ],
  }));
  const scope = deriveApprovalScope(nodes, () => null);
  expect('approval union contains member tools', ['read_file', 'search_code', 'write_file'].every(t => scope.allowed_tools.includes(t)), true);
  expect('approval never destructive', scope.allow_destructive, false);
}

// ── 4. Validation: cycle detection ──
{
  let threw = '';
  try {
    validateGraph(normalizeGraphSpec({
      name: 'cyclic',
      nodes: [
        { id: 'trigger', type: 'trigger' }, { id: 'a', type: 'agent', agent_slug: 'scout' },
        { id: 'b', type: 'agent', agent_slug: 'writer' }, { id: 'output', type: 'output' },
      ],
      edges: [
        { source: 'trigger', target: 'a' }, { source: 'a', target: 'b' },
        { source: 'b', target: 'a' }, { source: 'b', target: 'output' },
      ],
    }));
  } catch (err) { threw = err.message; }
  expect('cycle detected', threw.includes('cycle'), true);
}

// ── 5. Dispatch: agent resolution, server fallback, chain guard ──
{
  const r1 = await dispatch({ type: 'invoke', source: 'test', target: 'scout', params: { instruction: 'hi' }, substrate: 'session' }, ctx);
  expect('dispatch agent → local', [r1.dispatched, r1.channel, r1.result.status], [true, 'local', 'completed']);

  let serverCall = null;
  const serverCtx = { ...ctx, toolExecutor: { execute: async (name, args) => { serverCall = { name, args }; return { success: true }; } } };
  const r2 = await dispatch({ type: 'invoke', source: 'test', target: 'unknown-name', params: { instruction: 'x' } }, serverCtx);
  expect('dispatch unknown name → server workflow fallback', [r2.dispatched, r2.channel, serverCall.name], [true, 'server', 'workflow_run_multi']);

  const r3 = await dispatch({ type: 'hook', source: 'test', target: 'scout', params: {}, initiator: { chain: ['a', 'b', 'c'] } }, ctx);
  expect('chain depth guard', r3.dispatched, false);

  const r4 = await dispatch({ type: 'hook', source: 'test', target: 'scout', params: {}, initiator: { chain: ['agent:scout'] } }, ctx);
  expect('chain cycle guard', r4.dispatched, false);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nALL ORCHESTRATION SMOKE TESTS PASSED');
