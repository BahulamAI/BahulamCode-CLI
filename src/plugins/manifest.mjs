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
  for (const agentDef of (spec.agents || [])) {
    const agent = {
      slug: agentDef.slug || agentDef.name || '',
      name: agentDef.name || agentDef.slug || '',
      description: agentDef.description || '',
      role: agentDef.role || 'specialist',
      system_prompt: agentDef.system_prompt || agentDef.systemPrompt || agentDef.prompt || '',
      tools: Array.isArray(agentDef.tools) ? agentDef.tools : [],
      model: agentDef.model || null,
      source: `plugin:${name}`,
      source_scope: 'plugin',
    };
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
