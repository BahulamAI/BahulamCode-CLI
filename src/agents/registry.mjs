import { BUILTIN_AGENTS } from '../terminal/agents.mjs';
import { loadBahulamSettings } from '../config/settings-loader.mjs';
import { agentToSpec, listLocalAgents } from './scaffold.mjs';
import * as crypto from 'node:crypto';

export const SUB_AGENT_EVENT_SCHEMA = [
  { type: 'sub_agent_start', description: 'A delegated sub-agent run started.' },
  { type: 'sub_agent_tool', description: 'A sub-agent requested or completed a tool call.' },
  { type: 'sub_agent_complete', description: 'A delegated sub-agent run completed.' },
  { type: 'graph_run_start', description: 'A local workflow or delegated graph run started.' },
  { type: 'graph_node_start', description: 'One sub-agent, job, or service node started.' },
  { type: 'graph_node_result', description: 'One sub-agent, job, or service node completed.' },
  { type: 'graph_run_result', description: 'The local workflow or delegated graph run completed.' },
  { type: 'tool_call', description: 'A tool call was requested; sub_agent identifies delegated calls.' },
  { type: 'tool_result', description: 'A tool call completed; sub_agent identifies delegated calls.' },
  { type: 'content', description: 'A sub-agent emitted final or partial answer content.' },
  { type: 'error', description: 'A sub-agent, tool, or graph node failed.' },
];

const READ_ONLY_TOOLS = ['read_file', 'search_code', 'list_files', 'search_files', 'get_file_info'];

export function compactAgentMetadata(agent) {
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description || '',
    role: agent.role || 'specialist',
    model: agent.model || null,
    models: agent.models || undefined,
    tools: Array.isArray(agent.tools) ? agent.tools : [],
    capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
    domains: Array.isArray(agent.domains) ? agent.domains : [],
    source_scope: agent.source_scope || 'unknown',
    source: agent.source || '',
    content_hash: agent.content_hash || '',
    read_only: Boolean(agent.read_only || agent.readOnly),
    runnable: agent.runnable !== false,
  };
}

export function createAgentRegistry({
  cwd = process.cwd(),
  pluginRegistry = null,
  channel = 'main',
  settingsLoader = loadBahulamSettings,
} = {}) {
  function currentCwd() {
    return typeof cwd === 'function' ? cwd() : cwd || process.cwd();
  }

  function pluginAgentAllowlist() {
    try {
      const loaded = settingsLoader({ cwd: currentCwd() });
      const settings = loaded?.settings || loaded || {};
      const allowlist = settings?.plugins?.agent_allowlist;
      return Array.isArray(allowlist) ? allowlist.map(String) : [];
    } catch {
      return [];
    }
  }

  function normalizeAgentTools(tools) {
    if (Array.isArray(tools)) return tools.map(String).filter(Boolean);
    if (typeof tools === 'string') {
      return tools.split(',').map(item => item.trim()).filter(Boolean);
    }
    return READ_ONLY_TOOLS.slice(0, 3);
  }

  function pluginAgentToLocalShape(agentDef) {
    const slug = agentDef.slug || agentDef.name || '';
    const pluginName = agentDef._plugin_name || '';
    const base = {
      ...agentDef,
      slug,
      name: agentDef.name || slug,
      description: agentDef.description || '',
      role: agentDef.role || 'specialist',
      model: agentDef.model || null,
      models: agentDef.models || null,
      tools: normalizeAgentTools(agentDef.tools || agentDef.agent_tools),
      capabilities: Array.isArray(agentDef.capabilities) ? agentDef.capabilities : [],
      domains: Array.isArray(agentDef.domains) ? agentDef.domains : [],
      prompt: agentDef.prompt || agentDef.system_prompt || agentDef.systemPrompt || '',
      system_prompt: agentDef.system_prompt || agentDef.systemPrompt || agentDef.prompt || '',
      source_scope: 'plugin',
      source: agentDef.source || (pluginName ? `plugin:${pluginName}` : 'plugin'),
      content_hash: agentDef.content_hash || '',
    };
    const spec = agentDef.spec || agentToSpec(base);
    if (spec.config?.metadata && typeof spec.config.metadata === 'object') {
      spec.config.metadata.source = base.source;
      spec.config.metadata.source_scope = 'plugin';
    }
    spec.source = base.source;
    spec.source_scope = 'plugin';
    const content = JSON.stringify(spec);
    return {
      ...base,
      slug: spec.slug,
      spec,
      content_hash: agentDef.content_hash || crypto.createHash('sha256').update(content).digest('hex'),
    };
  }

  function platformAgentToLocalShape(def) {
    const base = {
      slug: def.command,
      command: def.command,
      name: def.name || def.command,
      description: def.description || '',
      role: 'platform',
      model: null,
      models: undefined,
      tools: Array.isArray(def.tools) && def.tools.length
        ? def.tools
        : (def.readOnly ? READ_ONLY_TOOLS : []),
      capabilities: [],
      domains: [],
      prompt: def.systemPrompt || '',
      system_prompt: def.systemPrompt || '',
      source_scope: 'platform',
      source: 'platform:cli',
      content_hash: '',
      read_only: Boolean(def.readOnly),
      readOnly: Boolean(def.readOnly),
      runnable: true,
    };
    const spec = agentToSpec(base);
    spec.source = base.source;
    spec.source_scope = 'platform';
    if (spec.config?.metadata && typeof spec.config.metadata === 'object') {
      spec.config.metadata.source = base.source;
      spec.config.metadata.source_scope = 'platform';
    }
    return { ...base, spec };
  }

  function listPlatformAgents() {
    return BUILTIN_AGENTS.map(platformAgentToLocalShape);
  }

  function listPluginAgents() {
    if (!pluginRegistry?.listAgents) return [];
    return pluginRegistry.listAgents().map(pluginAgentToLocalShape).filter(agent => agent.slug);
  }

  function listRunnables() {
    const bySlug = new Map();
    for (const agent of listLocalAgents(currentCwd())) {
      if (agent.slug && !bySlug.has(agent.slug)) {
        bySlug.set(agent.slug, { ...agent, runnable: true });
      }
    }
    for (const agent of listPlatformAgents()) {
      if (agent.slug && !bySlug.has(agent.slug)) {
        bySlug.set(agent.slug, agent);
      }
    }
    const allowlist = new Set(pluginAgentAllowlist());
    for (const agent of listPluginAgents()) {
      if (!agent.slug || bySlug.has(agent.slug)) continue;
      if (channel === 'workspace' || allowlist.has(agent.slug)) {
        bySlug.set(agent.slug, { ...agent, runnable: true });
      }
    }
    return [...bySlug.values()];
  }

  function listWorkspaceScopedPluginAgents() {
    const runnableSlugs = new Set(listRunnables().map(agent => agent.slug));
    return listPluginAgents()
      .filter(agent => agent.slug && !runnableSlugs.has(agent.slug))
      .map(agent => ({ ...agent, runnable: false }));
  }

  function listAvailableAgents() {
    // Backend workspaces such as kepler-code already implement their
    // platform roles (explore/plan/verify/debug/refactor) as reserved
    // meta-tool targets. Only send extension agents here so we do not
    // shadow the backend's native routing.
    return listRunnables().filter(agent => agent.source_scope !== 'platform');
  }

  function findAgent(target) {
    const needle = String(target || '').trim().toLowerCase();
    if (!needle) return null;
    return listRunnables().find(agent => [
      agent.slug,
      agent.id,
      agent.command,
      agent.name,
    ].some(value => String(value || '').trim().toLowerCase() === needle)) || null;
  }

  function filterAgents(args = {}) {
    let scope = String(args.scope || '').trim();
    if (scope === 'builtin') scope = 'platform';
    if (scope && !['project', 'global', 'plugin', 'platform'].includes(scope)) {
      throw new Error('scope must be "project", "global", "plugin", "platform", or "builtin"');
    }
    const pool = scope === 'plugin'
      ? [...listRunnables(), ...listWorkspaceScopedPluginAgents()]
      : listRunnables();
    const query = String(args.query || args.name || '').trim().toLowerCase();
    return pool
      .filter(agent => !scope || agent.source_scope === scope)
      .filter(agent => {
        if (!query) return true;
        return [
          agent.slug,
          agent.name,
          agent.description,
          agent.role,
          ...(Array.isArray(agent.capabilities) ? agent.capabilities : []),
          ...(Array.isArray(agent.domains) ? agent.domains : []),
        ].some(value => String(value || '').toLowerCase().includes(query));
      });
  }

  function observability() {
    return {
      version: 1,
      events: SUB_AGENT_EVENT_SCHEMA,
      correlation_fields: ['graph_run_id', 'node_id', 'sub_agent', 'sub_agent_run_id', 'call_id'],
      tool_attribution_fields: ['internal', 'sub_agent', 'subAgent'],
    };
  }

  return {
    listRunnables,
    listAvailableAgents,
    listPlatformAgents,
    listPluginAgents,
    listWorkspaceScopedPluginAgents,
    filterAgents,
    findAgent,
    observability,
  };
}
