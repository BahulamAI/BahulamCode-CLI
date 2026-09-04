/**
 * Plugin Registry — scan, load, validate, and deduplicate plugin manifests.
 *
 * Scans standard directories for plugin.yaml / plugin.json manifests.
 * Follows the same pattern as AgentLoader and SkillsLoader.
 */

import fs from 'fs';
import path from 'path';
import { parsePluginManifestFile, validatePluginManifest } from './manifest.mjs';
import { expandComposedTools } from './pi-compose.mjs';
import { bahulamHome } from '../core/paths.mjs';

const DEFAULT_PLUGIN_DIRS = () => [
  path.join(process.cwd(), '.bahulam', 'plugins'),
  path.join(bahulamHome(), 'plugins'),
];

export class PluginRegistry {
  /**
   * @param {Object} [options]
   * @param {string[]} [options.pluginDirs] - Directories to scan (default: project .bahulam/plugins + ~/.bahulam/plugins)
   * @param {string[]} [options.disabled] - Plugin names to skip
   * @param {string[]} [options.enabled] - If provided, only these plugin names are loaded
   * @param {string[]} [options.active] - Alias for enabled
   * @param {string} [options.pluginDir] - Legacy single plugin dir (mapped to pluginDirs[0])
   */
  constructor({ pluginDirs, disabled = [], enabled = null, active = null, pluginDir } = {}) {
    this.pluginDirs = pluginDirs || (pluginDir ? [pluginDir] : DEFAULT_PLUGIN_DIRS());
    this.disabled = new Set(
      (Array.isArray(disabled) ? disabled : [])
        .map(s => String(s).trim().toLowerCase())
        .filter(Boolean),
    );
    const enabledList = Array.isArray(enabled) ? enabled : (Array.isArray(active) ? active : []);
    this.enabled = new Set(
      enabledList
        .map(s => String(s).trim().toLowerCase())
        .filter(Boolean),
    );
    this.plugins = new Map(); // name → manifest
    this.errors = [];         // { name, message }
  }

  /**
   * Scan all plugin directories and load manifests.
   * @returns {this}
   */
  scan() {
    for (const dir of this.pluginDirs) {
      this._scanDir(dir);
    }
    return this;
  }

  _scanDir(dir) {
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(dir, entry.name);

        // Try plugin.yaml, plugin.json (in that order)
        let manifestPath = path.join(pluginDir, 'plugin.yaml');
        if (!fs.existsSync(manifestPath)) {
          manifestPath = path.join(pluginDir, 'plugin.json');
          if (!fs.existsSync(manifestPath)) continue;
        }

        const manifest = parsePluginManifestFile(manifestPath);
        if (!manifest) {
          this.errors.push({
            plugin: entry.name,
            message: `Failed to parse manifest: ${manifestPath}`,
          });
          continue;
        }

        this.register(manifest);
      }
    } catch (err) {
      if (process.env.DEBUG) {
        console.error(`Plugin registry scan error in ${dir}: ${err.message}`);
      }
    }
  }

  /**
   * Register a plugin manifest.
   * @param {object} manifest - Normalized manifest from normalizeManifest()
   * @returns {boolean} true if registered, false if skipped (disabled or duplicate)
   */
  register(manifest) {
    const name = manifest.metadata?.name || '';
    if (!name) return false;

    const lowerName = name.toLowerCase();
    const aliases = [
      lowerName,
      manifest._dir ? path.basename(manifest._dir).toLowerCase() : '',
    ].filter(Boolean);

    if (this.enabled.size > 0 && !aliases.some(alias => this.enabled.has(alias))) {
      return false;
    }

    // Check disabled list
    if (aliases.some(alias => this.disabled.has(alias))) {
      if (process.env.DEBUG) {
        console.warn(`Plugin "${name}" is disabled, skipping`);
      }
      return false;
    }

    // Check for existing (first wins — project overrides global)
    if (this.plugins.has(lowerName)) {
      return false; // silently skip duplicates
    }

    // Validate
    const { valid, errors } = validatePluginManifest(manifest);
    if (!valid) {
      this.errors.push({ plugin: name, message: errors.join('; ') });
      return false;
    }

    this.plugins.set(lowerName, manifest);
    return true;
  }

  /**
   * Get a plugin by name.
   * @param {string} name
   * @returns {object|null}
   */
  get(name) {
    return this.plugins.get(String(name || '').toLowerCase()) || null;
  }

  /**
   * List all registered plugins.
   * @returns {object[]}
   */
  list() {
    return [...this.plugins.values()];
  }

  /**
   * List all tools from all plugins.
   * @returns {object[]}
   */
  listTools() {
    const tools = [];
    for (const plugin of this.plugins.values()) {
      for (const tool of (plugin.config?.tools || [])) {
        tools.push({
          ...tool,
          _plugin_name: plugin.metadata?.name,
          _plugin_dir: plugin._dir,
        });
      }
      tools.push(...expandComposedTools(
        plugin.metadata?.name || '',
        plugin._dir,
        plugin.config?.composes || [],
      ));
    }
    return tools;
  }

  /**
   * List every plugin-declared MCP server across the registry.
   *
   * Each entry is [{plugin, name, config}] where `config` is a
   * Claude-Desktop-compatible object (command/args/env or url/headers).
   * Consumers spawn one McpClient per entry at session start; the
   * server's tools are then namespaced as `<name>.<tool>` in the
   * tool executor so two plugins can ship servers with the same tool
   * name without collision.
   * @returns {{plugin: string, name: string, config: object}[]}
   */
  listMcpServers() {
    const out = [];
    for (const plugin of this.plugins.values()) {
      const servers = plugin.config?.mcpServers || {};
      const pluginName = plugin.metadata?.name || '';
      for (const [name, config] of Object.entries(servers)) {
        if (config && typeof config === 'object') {
          out.push({ plugin: pluginName, name, config });
        }
      }
    }
    return out;
  }

  /**
   * List all agents from all plugins.
   * @returns {object[]}
   */
  listAgents() {
    const agents = [];
    for (const plugin of this.plugins.values()) {
      for (const agent of (plugin.config?.agents || [])) {
        agents.push({
          ...agent,
          _plugin_name: plugin.metadata?.name,
        });
      }
    }
    return agents;
  }

  /**
   * Check if a plugin exists.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.plugins.has(String(name || '').toLowerCase());
  }

  /**
   * Remove a plugin by name.
   * @param {string} name
   * @returns {boolean}
   */
  remove(name) {
    return this.plugins.delete(String(name || '').toLowerCase());
  }

  /**
   * Get plugin count.
   * @returns {number}
   */
  count() {
    return this.plugins.size;
  }
}
