/**
 * Plugin Registry — scan, load, validate, and deduplicate plugin manifests.
 *
 * Scans standard directories for plugin.yaml / plugin.json manifests.
 * Follows the same pattern as AgentLoader and SkillsLoader.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { parsePluginManifestFile, validatePluginManifest } from './manifest.mjs';

const DEFAULT_PLUGIN_DIRS = () => [
  path.join(process.cwd(), '.bahulam', 'plugins'),
  path.join(os.homedir(), '.bahulam', 'plugins'),
];

export class PluginRegistry {
  /**
   * @param {Object} [options]
   * @param {string[]} [options.pluginDirs] - Directories to scan (default: project .bahulam/plugins + ~/.bahulam/plugins)
   * @param {string[]} [options.disabled] - Plugin names to skip
   * @param {string} [options.pluginDir] - Legacy single plugin dir (mapped to pluginDirs[0])
   */
  constructor({ pluginDirs, disabled = [], pluginDir } = {}) {
    this.pluginDirs = pluginDirs || (pluginDir ? [pluginDir] : DEFAULT_PLUGIN_DIRS());
    this.disabled = new Set(
      (Array.isArray(disabled) ? disabled : [])
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

    // Check disabled list
    if (this.disabled.has(lowerName)) {
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
      for (const tool of (plugin.spec?.tools || [])) {
        tools.push({
          ...tool,
          _plugin_name: plugin.metadata?.name,
          _plugin_dir: plugin._dir,
        });
      }
    }
    return tools;
  }

  /**
   * List all agents from all plugins.
   * @returns {object[]}
   */
  listAgents() {
    const agents = [];
    for (const plugin of this.plugins.values()) {
      for (const agent of (plugin.spec?.agents || [])) {
        agents.push(agent);
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