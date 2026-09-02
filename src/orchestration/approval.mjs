import { canonicalToolName } from '../terminal/agents.mjs';

// Baseline read tools every graph run may use regardless of member agents.
const BASE_READ_TOOLS = ['read_file', 'search_code', 'list_files', 'get_file_info', 'get_project_overview'];

/**
 * Derive the approval scope for a graph run from the union of its member
 * agents' effective tool allowlists (node.tools narrows agent.tools when
 * present), replacing any hardcoded per-run tool list. Destructive
 * escalation is never pre-approved.
 */
export function deriveApprovalScope(agentNodes, resolveAgent) {
  const allowed = new Set(BASE_READ_TOOLS);
  for (const node of agentNodes) {
    if (node.type === 'job' || node.type === 'service') {
      allowed.add('shell');
      continue;
    }
    const agent = node.agent || resolveAgent(node.agent_slug);
    if (!agent) continue;
    const agentTools = (Array.isArray(agent.tools) ? agent.tools : []).map(canonicalToolName);
    const nodeTools = (Array.isArray(node.tools) && node.tools.length)
      ? new Set(node.tools.map(canonicalToolName))
      : null;
    for (const tool of agentTools) {
      if (!nodeTools || nodeTools.has(tool)) allowed.add(tool);
    }
  }
  return { allowed_tools: [...allowed].sort(), allow_destructive: false };
}
