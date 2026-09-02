/**
 * Tag every event from a node's execution with graph/node attribution so
 * renderers group them as sub-agent work and history builders exclude
 * them from the primary transcript (same treatment direct agent runs get).
 */
export async function* namespaceNodeEvents(iterable, { node, runId }) {
  const slug = node.agent_slug || node.id;
  for await (const event of iterable) {
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    yield {
      ...event,
      data: { ...data, internal: true, sub_agent: slug, graph_run_id: runId, node_id: node.id },
    };
  }
}

export function graphEvent(type, runId, data = {}) {
  return { type, data: { graph_run_id: runId, ...data } };
}
