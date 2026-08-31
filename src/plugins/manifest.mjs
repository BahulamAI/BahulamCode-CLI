/**
 * Plugin Manifest Parser — parse and validate bahulam.plugin/1 manifests.
 *
 * Supports YAML (plugin.yaml) format.
 */

import fs from 'fs';
import path from 'path';
import { load as yamlLoad } from 'js-yaml';

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

function loadAgentHandler(agentDef, pluginDir) {
  const handler = String(agentDef.handler || agentDef.file || '').trim();
  if (!handler || !pluginDir) return {};
  try {
    const handlerPath = path.resolve(pluginDir, handler);
    const raw = fs.readFileSync(handlerPath, 'utf-8');
    return path.extname(handlerPath).toLowerCase() === '.json'
      ? JSON.parse(raw)
      : parseYaml(raw);
  } catch (err) {
    if (process.env.DEBUG) {
      console.error(`Failed to load plugin agent handler ${handler}: ${err.message}`);
    }
    return {};
  }
}

function normalizeAgentDef(agentDef, pluginName, pluginDir) {
  const handlerConfig = loadAgentHandler(agentDef, pluginDir);
  const metadata = handlerConfig.metadata || handlerConfig.meta || {};
  const agent = handlerConfig.agent || handlerConfig.spec?.agent || {};
  const handlerTools = (
    handlerConfig.tools
    || handlerConfig.spec?.tools
    || agent.tools
    || []
  );
  const inlineTools = normalizeToolNames(agentDef.tools);

  return {
    slug: agentDef.slug || metadata.slug || handlerConfig.slug || metadata.name || handlerConfig.name || agentDef.name || '',
    name: agentDef.name || metadata.name || handlerConfig.name || agentDef.slug || '',
    description: agentDef.description || metadata.description || handlerConfig.description || '',
    role: agentDef.role || metadata.role || handlerConfig.role || 'specialist',
    system_prompt: (
      agentDef.system_prompt
      || agentDef.systemPrompt
      || agentDef.prompt
      || agent.system_prompt
      || agent.systemPrompt
      || agent.prompt
      || handlerConfig.system_prompt
      || handlerConfig.prompt
      || ''
    ),
    tools: inlineTools.length ? inlineTools : normalizeToolNames(handlerTools),
    model: agentDef.model || agent.model || handlerConfig.model || null,
    models: agentDef.models || agent.models || handlerConfig.models || undefined,
    max_tokens: agentDef.max_tokens || agent.max_tokens || handlerConfig.max_tokens || undefined,
    max_iterations: agentDef.max_iterations || agent.max_iterations || handlerConfig.max_iterations || undefined,
    handler: agentDef.handler || agentDef.file || '',
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
  const spec = raw.spec || raw.plugin || {};
  const name = meta.name || spec.name || '';
  if (!name) {
    if (process.env.DEBUG) {
      console.warn(`Plugin manifest missing name: ${source}`);
    }
    return null;
  }

  // Normalize agents
  const agents = [];
  const pluginDir = source ? path.dirname(source) : '';
  for (const agentDef of (spec.agents || [])) {
    const agent = normalizeAgentDef(agentDef, name, pluginDir);
    if (agent.slug) agents.push(agent);
  }

  // Normalize tools
  const tools = [];
  for (const toolDef of (spec.tools || [])) {
    const tool = {
      name: toolDef.name || '',
      description: toolDef.description || '',
      input_schema: toolDef.parameters || toolDef.input_schema || toolDef.inputSchema || { type: 'object', properties: {} },
      handler: toolDef.handler || toolDef.file || '',
      plugin_name: name,
    };
    if (tool.name) tools.push(tool);
  }

  // Normalize workspace
  const workspace = spec.workspace || {};
  if (workspace.views && !Array.isArray(workspace.views)) {
    workspace.views = [];
  }

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
    spec: {
      tools,
      agents,
      workspace,
    },
    source,
    _dir: source ? path.dirname(source) : '',
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

  if (manifest.spec) {
    for (const tool of (manifest.spec.tools || [])) {
      if (!tool.name) errors.push('Tool missing name');
      if (!tool.handler) errors.push(`Tool "${tool.name || '(unnamed)'}" missing handler path`);
    }
    for (const agent of (manifest.spec.agents || [])) {
      if (!agent.slug && !agent.name) errors.push('Agent missing slug or name');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
