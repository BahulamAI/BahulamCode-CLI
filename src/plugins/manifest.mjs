/**
 * Plugin Manifest Parser — parse and validate bahulam.plugin/1 manifests.
 *
 * Supports YAML (plugin.yaml) format.
 */

import fs from 'fs';
import path from 'path';
import { load as yamlLoad } from 'js-yaml';
import { normalizeComposes } from './pi-compose.mjs';

/**
 * Parse a YAML text string into an object using js-yaml.
 * @param {string} text - Raw YAML content
 * @returns {object}
 */
function parseYaml(text) {
  return yamlLoad(text) || {};
}

function normalizeToolNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object') return String(item.name || item.tool || item.id || '').trim();
    return '';
  }).filter(Boolean);
}

function normalizePathList(value) {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  return [];
}

function addAgent(agents, seen, agent) {
  if (!agent?.slug) return;
  const key = String(agent.slug).trim().toLowerCase();
  if (!key || seen.has(key)) return;
  seen.add(key);
  agents.push(agent);
}

function loadAgentFile(agentDef, pluginDir) {
  const file = String(agentDef.file || agentDef.handler || '').trim();
  if (!file || !pluginDir) return {};
  try {
    const filePath = path.resolve(pluginDir, file);
    const raw = fs.readFileSync(filePath, 'utf-8');
    return path.extname(filePath).toLowerCase() === '.json'
      ? JSON.parse(raw)
      : parseYaml(raw);
  } catch (err) {
    if (process.env.DEBUG) {
      console.error(`Failed to load plugin agent file ${file}: ${err.message}`);
    }
    return {};
  }
}

function normalizeAgentDef(agentDef, pluginName, pluginDir) {
  const fileConfig = loadAgentFile(agentDef, pluginDir);
  const metadata = fileConfig.metadata || fileConfig.meta || {};
  const agent = fileConfig.agent || fileConfig.config?.agent || {};
  const fileTools = (
    fileConfig.tools
    || fileConfig.config?.tools
    || agent.tools
    || []
  );
  const inlineTools = normalizeToolNames(agentDef.tools);

  return {
    slug: agentDef.slug || metadata.slug || fileConfig.slug || metadata.name || fileConfig.name || agentDef.name || '',
    name: agentDef.name || metadata.name || fileConfig.name || agentDef.slug || '',
    description: agentDef.description || metadata.description || fileConfig.description || '',
    role: agentDef.role || metadata.role || fileConfig.role || 'specialist',
    system_prompt: (
      agentDef.system_prompt
      || agentDef.systemPrompt
      || agentDef.prompt
      || agent.system_prompt
      || agent.systemPrompt
      || agent.prompt
      || fileConfig.system_prompt
      || fileConfig.prompt
      || ''
    ),
    tools: inlineTools.length ? inlineTools : normalizeToolNames(fileTools),
    model: agentDef.model || agent.model || fileConfig.model || null,
    models: agentDef.models || agent.models || fileConfig.models || undefined,
    max_tokens: agentDef.max_tokens || agent.max_tokens || fileConfig.max_tokens || undefined,
    max_iterations: agentDef.max_iterations || agent.max_iterations || fileConfig.max_iterations || undefined,
    file: agentDef.file || agentDef.handler || '',
    source: `plugin:${pluginName}`,
    source_scope: 'plugin',
  };
}

/**
 * Parse a plugin manifest from YAML text.
 * @param {string} yamlText - Raw YAML content
 * @param {string} [filePath] - Source path for error messages
 * @returns {object|null} Normalized manifest or null on failure
 */
export function parsePluginManifest(yamlText, filePath = '') {
  try {
    const raw = parseYaml(yamlText);
    return normalizeManifest(raw, filePath);
  } catch (err) {
    if (process.env.DEBUG) {
      console.error(`Failed to parse plugin manifest ${filePath}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Parse a plugin manifest from a file.
 * @param {string} manifestPath - Path to plugin.yaml or plugin.json
 * @returns {object|null}
 */
export function parsePluginManifestFile(manifestPath) {
  try {
    const ext = path.extname(manifestPath).toLowerCase();
    const content = fs.readFileSync(manifestPath, 'utf-8');
    if (ext === '.json') {
      const raw = JSON.parse(content);
      return normalizeManifest(raw, manifestPath);
    }
    return parsePluginManifest(content, manifestPath);
  } catch (err) {
    if (process.env.DEBUG) {
      console.error(`Failed to read plugin manifest ${manifestPath}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Normalize and validate a raw manifest object.
 * @param {object} raw
 * @param {string} [source]
 * @returns {object|null}
 */
export function normalizeManifest(raw, source = '') {
  if (!raw || typeof raw !== 'object') return null;

  const apiVersion = raw.apiVersion || raw.api_version || '';
  if (apiVersion !== 'bahulam.plugin/1') {
    if (process.env.DEBUG) {
      console.warn(`Unsupported plugin apiVersion: ${apiVersion} in ${source}`);
    }
    return null;
  }

  const meta = raw.metadata || raw.meta || {};
  const config = raw.config || raw.plugin || {};
  const name = meta.name || config.name || '';
  if (!name) {
    if (process.env.DEBUG) {
      console.warn(`Plugin manifest missing name: ${source}`);
    }
    return null;
  }

  // Normalize agents
  const agents = [];
  const agentSlugs = new Set();
  const pluginDir = source ? path.dirname(source) : '';
  for (const agentDef of (config.agents || [])) {
    addAgent(agents, agentSlugs, normalizeAgentDef(agentDef, name, pluginDir));
  }
  // Optional authoring convenience: `config.agents_from: <dir|string[]>`.
  // Published plugins should inline `config.agents[]` so backend and
  // marketplace consumers can parse one file. npm expands these paths
  // after inline agents; duplicate slugs keep the inline definition.
  const agentsFrom = normalizePathList(config.agents_from);
  for (const agentsFromPath of agentsFrom) {
    if (!pluginDir) continue;
    const agentsDir = path.resolve(pluginDir, agentsFromPath);
    try {
      if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
        const files = fs.readdirSync(agentsDir)
          .filter(f => /\.(ya?ml)$/i.test(f))
          .sort();
        for (const f of files) {
          const filePath = path.join(agentsDir, f);
          let agentDef;
          try {
            agentDef = parseYaml(fs.readFileSync(filePath, 'utf-8'));
          } catch (err) {
            console.warn(`Failed to parse plugin agent file ${filePath}: ${err.message}`);
            continue;
          }
          if (!agentDef || typeof agentDef !== 'object') {
            console.warn(`Skipping plugin agent file ${filePath}: not a mapping`);
            continue;
          }
          const agent = normalizeAgentDef(agentDef, name, pluginDir);
          if (!agent.slug) {
            console.warn(`Skipping plugin agent file ${filePath}: no slug`);
            continue;
          }
          addAgent(agents, agentSlugs, agent);
        }
      }
    } catch (err) {
      if (process.env.DEBUG) {
        console.error(`Failed to load agents_from ${agentsDir}: ${err.message}`);
      }
    }
  }

  // Normalize tools
  const tools = [];
  for (const toolDef of (config.tools || [])) {
    const tool = {
      name: toolDef.name || '',
      description: toolDef.description || '',
      input_schema: toolDef.parameters || toolDef.input_schema || toolDef.inputSchema || { type: 'object', properties: {} },
      tool: toolDef.tool || toolDef.file || toolDef.handler || '',
      plugin_name: name,
    };
    if (tool.name) tools.push(tool);
  }

  // Normalize workspace
  const workspace = config.workspace || {};
  if (workspace.views && !Array.isArray(workspace.views)) {
    workspace.views = [];
  }

  // Normalize MCP servers — the Plugin=MCP+UX story. Two sources are
  // merged so authors can either:
  //   (a) declare mcpServers: {} inline in plugin.yaml (Bahulam-native)
  //   (b) drop a sibling mcp.json in Claude-Desktop format (portable —
  //       any config that works in Claude Desktop / Cursor / Cline
  //       transfers with zero edits)
  // Inline wins on name collision so authors can override a portable
  // config for the local plugin without editing mcp.json.
  const mcpServers = _readMcpServers(config.mcpServers, source);
  const composes = normalizeComposes(config.composes);

  return {
    apiVersion,
    kind: raw.kind || 'Plugin',
    metadata: {
      name,
      version: meta.version || '0.0.0',
      description: meta.description || '',
      author: meta.author || '',
      repository: meta.repository || '',
    },
    config: {
      tools,
      agents,
      ...(agentsFrom.length ? { agents_from: agentsFrom } : {}),
      workspace,
      mcpServers,
      composes,
    },
    source,
    _dir: source ? path.dirname(source) : '',
  };
}

/**
 * Merge inline `mcpServers:` from plugin.yaml with a sibling mcp.json.
 * Both should be dicts of `{<name>: {command|url, args?, env?, headers?}}`
 * following the Claude Desktop convention. Returns `{}` when neither is
 * present so callers can iterate without a nullability check.
 * @param {object|null|undefined} inline
 * @param {string} manifestPath  used to locate mcp.json next to it
 * @returns {Object<string, object>}
 */
function _readMcpServers(inline, manifestPath) {
  const merged = {};
  // Sibling mcp.json first — inline overrides on name collision.
  if (manifestPath) {
    const jsonPath = path.join(path.dirname(manifestPath), 'mcp.json');
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const servers = raw?.mcpServers || raw?.mcp_servers || raw || {};
        if (servers && typeof servers === 'object') {
          for (const [name, cfg] of Object.entries(servers)) {
            if (cfg && typeof cfg === 'object') merged[name] = _normalizeMcpServer(cfg);
          }
        }
      } catch (err) {
        if (process.env.DEBUG) console.error(`Failed to read ${jsonPath}: ${err.message}`);
      }
    }
  }
  if (inline && typeof inline === 'object') {
    for (const [name, cfg] of Object.entries(inline)) {
      if (cfg && typeof cfg === 'object') merged[name] = _normalizeMcpServer(cfg);
    }
  }
  return merged;
}

function _normalizeMcpServer(cfg) {
  return {
    command: cfg.command || undefined,
    args: Array.isArray(cfg.args) ? cfg.args : undefined,
    env: cfg.env && typeof cfg.env === 'object' ? cfg.env : undefined,
    url: cfg.url || undefined,
    headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : undefined,
    transport: cfg.transport || undefined,
  };
}

/**
 * Validate a normalized manifest and return errors.
 * @param {object} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePluginManifest(manifest) {
  const errors = [];

  if (!manifest) {
    return { valid: false, errors: ['Manifest is null or undefined'] };
  }

  if (manifest.apiVersion !== 'bahulam.plugin/1') {
    errors.push(`Unsupported apiVersion: ${manifest.apiVersion}. Expected bahulam.plugin/1`);
  }

  if (!manifest.metadata?.name) {
    errors.push('Plugin metadata.name is required');
  }

  if (manifest.config) {
    for (const tool of (manifest.config.tools || [])) {
      if (!tool.name) errors.push('Tool missing name');
      if (!tool.tool) errors.push(`Tool "${tool.name || '(unnamed)'}" missing tool module path (tool: ./tools/<name>.mjs)`);
    }
    for (const agent of (manifest.config.agents || [])) {
      if (!agent.slug && !agent.name) errors.push('Agent missing slug or name');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
