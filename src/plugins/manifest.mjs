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

function normalizeViews(value) {
  return Array.isArray(value) ? value.filter(view => view && typeof view === 'object') : [];
}

function normalizeWorkspaceDeclaration(value) {
  if (typeof value === 'string' && value.trim()) {
    return { agentPath: value.trim(), views: [] };
  }
  if (value && typeof value === 'object') {
    const agentPath = String(value.agent || value.file || value.source || '').trim();
    return { agentPath, views: normalizeViews(value.views) };
  }
  return { agentPath: '', views: [] };
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
  const loadedConfig = loadAgentFile(agentDef, pluginDir);
  const hasLoadedConfig = loadedConfig && Object.keys(loadedConfig).length > 0;
  const fileConfig = hasLoadedConfig ? loadedConfig : (agentDef || {});
  const metadata = fileConfig.metadata || fileConfig.meta || {};
  const agent = fileConfig.agent || fileConfig.config?.agent || {};
  const fileTools = (
    fileConfig.tools
    || fileConfig.config?.tools
    || agent.tools
    || []
  );
  const inlineTools = normalizeToolNames(agentDef.tools);
  const slug = (
    agentDef.slug
    || metadata.slug
    || fileConfig.slug
    || agent.slug
    || agentDef.id
    || metadata.name
    || fileConfig.name
    || agentDef.name
    || metadata.role
    || fileConfig.role
    || ''
  );

  return {
    slug,
    name: agentDef.name || metadata.name || fileConfig.name || agent.name || slug || '',
    description: agentDef.description || metadata.description || fileConfig.description || agent.description || '',
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
    disallowed_tools: metadata.disallowedTools || metadata.disallowed_tools || fileConfig.disallowedTools || fileConfig.disallowed_tools || [],
    can_delegate: agentDef.can_delegate ?? agent.can_delegate ?? fileConfig.can_delegate ?? false,
    can_be_delegated_to: agentDef.can_be_delegated_to ?? agent.can_be_delegated_to ?? fileConfig.can_be_delegated_to ?? true,
    apiVersion: fileConfig.apiVersion || fileConfig.api_version || undefined,
    kind: fileConfig.kind || undefined,
    file: agentDef.file || agentDef.handler || '',
    source: `plugin:${pluginName}`,
    source_scope: 'plugin',
  };
}

function loadAgentPath(agentPath, pluginDir, pluginName, label) {
  if (!agentPath || !pluginDir) return null;
  const fullPath = path.resolve(pluginDir, agentPath);
  try {
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return null;
    const agentDef = parseYaml(fs.readFileSync(fullPath, 'utf-8'));
    if (!agentDef || typeof agentDef !== 'object') {
      console.warn(`Skipping ${label} ${fullPath}: not a mapping`);
      return null;
    }
    const agent = normalizeAgentDef(agentDef, pluginName, pluginDir);
    if (!agent.slug) {
      console.warn(`Skipping ${label} ${fullPath}: no slug`);
      return null;
    }
    return agent;
  } catch (err) {
    console.warn(`Failed to load ${label} ${fullPath}: ${err.message}`);
    return null;
  }
}

// Identifiers that are safe to interpolate into DDL. Manifests are
// plugin-author controlled, but a typo (or a malicious registry entry)
// must never be able to escape the quoted identifier and inject SQL.
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// SQLite type affinities. Anything else collapses to TEXT so a bad
// manifest degrades into a working table instead of a failed CREATE.
const SQL_TYPES = new Set(['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC']);

function normalizeSqlType(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return 'TEXT';
  // Accept the common aliases rather than rejecting an otherwise-fine manifest.
  if (raw === 'INT' || raw === 'BIGINT') return 'INTEGER';
  if (raw === 'BOOL' || raw === 'BOOLEAN') return 'INTEGER';
  if (raw === 'FLOAT' || raw === 'DOUBLE') return 'REAL';
  if (raw === 'STRING' || raw === 'VARCHAR' || raw === 'DATETIME' || raw === 'TIMESTAMP' || raw === 'JSON') return 'TEXT';
  return SQL_TYPES.has(raw) ? raw : 'TEXT';
}

/**
 * Normalize `config.state` — the manifest-declared state schema plus the
 * agent-visibility contract for that state.
 *
 * Every plugin already gets a SQLite sidecar for free (the `kv` and
 * `records` tables). This block is how a plugin graduates from "a tool
 * that remembers a cursor" to "a local app that owns its own domain
 * tables" (questions + answers + progress for a tutor, documents for a
 * study aid, and so on).
 *
 * Three parts, matching the three visibility tiers:
 *
 *   tables          DDL applied idempotently whenever the plugin's state
 *                   DB is opened. Existing columns are never dropped;
 *                   new columns are added with ALTER TABLE so a version
 *                   bump never costs the user their data.
 *   context_always  Small, high-signal slices injected into the agent
 *                   context every turn (current lesson, progress).
 *   context_tools   Read-only tools auto-generated for the agent to call
 *                   on demand for the larger data (list questions).
 *
 * Anything not declared here stays reachable only from the plugin's own
 * handlers via `state.query()` — the third tier.
 *
 * @param {object|null|undefined} value raw `config.state`
 * @returns {{tables: object[], context_always: object[], context_tools: object[]}}
 */
function normalizeState(value) {
  const empty = { tables: [], context_always: [], context_tools: [] };
  if (!value || typeof value !== 'object') return empty;

  const tables = [];
  for (const rawTable of (Array.isArray(value.tables) ? value.tables : [])) {
    if (!rawTable || typeof rawTable !== 'object') continue;
    const name = String(rawTable.name || '').trim();
    if (!SAFE_IDENT_RE.test(name)) {
      console.warn(`Skipping state table with unsafe or missing name: ${JSON.stringify(rawTable.name)}`);
      continue;
    }

    const columns = [];
    const columnNames = new Set();
    for (const rawCol of (Array.isArray(rawTable.columns) ? rawTable.columns : [])) {
      if (!rawCol || typeof rawCol !== 'object') continue;
      const colName = String(rawCol.name || '').trim();
      if (!SAFE_IDENT_RE.test(colName)) {
        console.warn(`Skipping column with unsafe or missing name in table ${name}: ${JSON.stringify(rawCol.name)}`);
        continue;
      }
      if (columnNames.has(colName)) continue;
      columnNames.add(colName);

      // `references` is free-form in the manifest, so validate the shape
      // strictly before it reaches a CREATE TABLE string.
      const references = String(rawCol.references || '').trim();
      const safeReferences = /^[A-Za-z_][A-Za-z0-9_]{0,63}\s*\(\s*[A-Za-z_][A-Za-z0-9_]{0,63}\s*\)$/.test(references)
        ? references.replace(/\s+/g, '')
        : null;
      if (references && !safeReferences) {
        console.warn(`Ignoring malformed references "${references}" on ${name}.${colName}`);
      }

      const primary = rawCol.primary === true || rawCol.primary_key === true || rawCol.primaryKey === true;
      const type = normalizeSqlType(rawCol.type);
      columns.push({
        name: colName,
        type,
        primary,
        // SQLite only allows AUTOINCREMENT on INTEGER PRIMARY KEY.
        autoincrement: (rawCol.autoincrement === true || rawCol.auto_increment === true)
          && primary && type === 'INTEGER',
        not_null: rawCol.not_null === true || rawCol.notNull === true,
        default: rawCol.default === undefined || rawCol.default === null ? null : String(rawCol.default),
        references: safeReferences,
      });
    }
    if (!columns.length) {
      console.warn(`Skipping state table ${name}: no usable columns`);
      continue;
    }

    const indexes = [];
    for (const rawIndex of (Array.isArray(rawTable.indexes) ? rawTable.indexes : [])) {
      if (!rawIndex || typeof rawIndex !== 'object') continue;
      const source = Array.isArray(rawIndex.columns) ? rawIndex.columns
        : (rawIndex.column ? [rawIndex.column] : []);
      const indexColumns = source
        .map(c => String(c || '').trim())
        .filter(c => SAFE_IDENT_RE.test(c) && columnNames.has(c));
      if (indexColumns.length) {
        indexes.push({ columns: indexColumns, unique: rawIndex.unique === true });
      }
    }

    tables.push({ name, columns, indexes });
  }

  const tableNames = new Set(tables.map(t => t.name));

  // Tier 1 — injected every turn. Accept a bare string as a kv key so the
  // common case stays a one-liner in YAML.
  const contextAlways = [];
  for (const rawEntry of (Array.isArray(value.context_always) ? value.context_always : [])) {
    if (typeof rawEntry === 'string') {
      const key = rawEntry.trim();
      if (key) contextAlways.push({ kind: 'kv', key });
      continue;
    }
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const stream = String(rawEntry.stream || '').trim();
    if (stream) {
      const limit = Number(rawEntry.limit);
      contextAlways.push({
        kind: 'records',
        stream,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 50) : 5,
      });
      continue;
    }
    const key = String(rawEntry.kv_key || rawEntry.key || '').trim();
    if (key) contextAlways.push({ kind: 'kv', key });
  }

  // Tier 2 — auto-generated read-only tools.
  const contextTools = [];
  for (const rawTool of (Array.isArray(value.context_tools) ? value.context_tools : [])) {
    if (!rawTool || typeof rawTool !== 'object') continue;
    const name = String(rawTool.name || '').trim();
    if (!SAFE_IDENT_RE.test(name)) {
      console.warn(`Skipping context tool with unsafe or missing name: ${JSON.stringify(rawTool.name)}`);
      continue;
    }
    const table = String(rawTool.table || '').trim();
    if (!tableNames.has(table)) {
      console.warn(`Skipping context tool ${name}: table "${table}" is not declared in config.state.tables`);
      continue;
    }
    const parameters = rawTool.parameters && typeof rawTool.parameters === 'object'
      ? rawTool.parameters
      : { type: 'object', properties: {} };
    // Bind order for a positional `where` clause. Defaults to the declared
    // property order so the simple case needs no extra YAML — minus
    // `limit`, which the CLI consumes itself and must never be bound into
    // the WHERE clause.
    const declaredParams = Array.isArray(rawTool.params)
      ? rawTool.params.map(p => String(p || '').trim()).filter(p => SAFE_IDENT_RE.test(p))
      : Object.keys(parameters.properties || {}).filter(p => p !== 'limit');
    const limit = Number(rawTool.limit);
    contextTools.push({
      name,
      table,
      description: String(rawTool.description || `List rows from ${table}`),
      parameters,
      // Plugin-authored SQL, same trust model as state.query(): the author
      // owns the clause, the CLI binds the values.
      where: String(rawTool.where || '').trim(),
      params: declaredParams,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 500) : 50,
    });
  }

  return { tables, context_always: contextAlways, context_tools: contextTools };
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
  const workspaceDecl = normalizeWorkspaceDeclaration(config.workspace);
  if (workspaceDecl.agentPath) {
    const workspaceAgent = loadAgentPath(workspaceDecl.agentPath, pluginDir, name, 'workspace');
    if (workspaceAgent) {
      workspaceAgent.entry_agent = true;
      addAgent(agents, agentSlugs, workspaceAgent);
    }
  }
  // Optional authoring convenience: `config.agents_from: <dir|string[]>`.
  // This is for delegated sub-agents. The primary/entry agent should
  // live at `config.workspace: ./config/workspace.yaml`.
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

  // Normalize browser workspace views. New manifests use `config.views`.
  // Older installed manifests with `config.workspace.views` still render.
  const views = [
    ...workspaceDecl.views,
    ...normalizeViews(config.views),
  ];

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
  const state = normalizeState(config.state);

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
      workspace: workspaceDecl.agentPath,
      views,
      mcpServers,
      composes,
      state,
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

    // State declarations that silently vanished during normalization are
    // exactly the kind of thing an author wants to hear about at validate
    // time rather than discover at runtime.
    const state = manifest.config.state;
    if (state) {
      const declaredTables = new Set((state.tables || []).map(t => t.name));
      for (const tool of (state.context_tools || [])) {
        if (!declaredTables.has(tool.table)) {
          errors.push(`State context tool "${tool.name}" references undeclared table "${tool.table}"`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
