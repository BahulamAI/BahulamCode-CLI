/**
 * Plugin Manifest Parser — parse and validate bahulam.plugin/1 manifests.
 *
 * Supports YAML (plugin.yaml) format.
 */

import fs from 'fs';
import path from 'path';

/**
 * Minimal YAML parser for plugin manifests.
 * Handles indented keys, arrays, and scalars.
 */
function parseYaml(text) {
  const lines = String(text || '').split('\n');
  const result = {};
  const stack = [{ obj: result, indent: -1 }];
  let currentKey = null;
  let inBlockString = false;
  let blockStringIndent = 0;
  let blockStringLines = [];

  for (let raw of lines) {
    const line = raw.trimEnd();

    // Handle block scalar (|) continuation
    if (inBlockString) {
      const leading = raw.match(/^\s*/)[0].length;
      if (leading > blockStringIndent || line === '') {
        blockStringLines.push(line);
        continue;
      }
      // End of block string — assign it
      _setPath(stack, currentKey, blockStringLines.join('\n'));
      inBlockString = false;
      blockStringLines = [];
      currentKey = null;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ')) {
      // Array item
      const value = trimmed.slice(2).trim();
      _pushToArray(stack, value);
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();
    const indent = raw.search(/\S/);

    // Adjust stack to current indent level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].obj;

    if (rest === '') {
      // New object
      const child = {};
      if (Array.isArray(current)) {
        current.push(child);
        stack.push({ obj: child, indent });
      } else {
        current[key] = child;
        stack.push({ obj: child, indent });
      }
      currentKey = null;
    } else if (rest === '|') {
      // Block scalar — collect next lines
      inBlockString = true;
      blockStringIndent = indent;
      blockStringLines = [];
      currentKey = key;
    } else {
      // Scalar value
      const value = _parseYamlValue(rest);
      if (Array.isArray(current)) {
        current.push(value);
      } else {
        current[key] = value;
      }
      currentKey = null;
    }
  }

  // Flush any trailing block string
  if (inBlockString && currentKey) {
    _setPath(stack, currentKey, blockStringLines.join('\n'));
  }

  return result;
}

function _setPath(stack, key, value) {
  const current = stack[stack.length - 1].obj;
  current[key] = value;
}

function _pushToArray(stack, value) {
  const current = stack[stack.length - 1].obj;
  // Check if parent has an array we should push to
  let arr = current._array;
  if (!arr) {
    // We need to find the actual array parent
    const parent = stack.length > 1 ? stack[stack.length - 2].obj : null;
    if (parent && Array.isArray(parent)) {
      parent.push(parseYamlValue(value));
    } else if (current && typeof current === 'object') {
      // Find the first property that is an array
      for (const k of Object.keys(current)) {
        if (Array.isArray(current[k])) {
          current[k].push(parseYamlValue(value));
          return;
        }
      }
    }
    return;
  }
  arr.push(parseYamlValue(value));
}

function parseYamlValue(raw) {
  const value = String(raw || '').trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  const num = Number(value);
  if (!isNaN(num) && value !== '' && /^-?\d+\.?\d*$/.test(value)) return num;
  return value;
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
