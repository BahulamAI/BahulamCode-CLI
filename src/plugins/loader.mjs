/**
 * Plugin Loader — high-level facade for installing, listing, and removing plugins.
 *
 * Uses PluginRegistry for scanning/loading, and provides git-based install.
 * Plugin format: a directory with plugin.yaml (bahulam.plugin/1).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { PluginRegistry } from './registry.mjs';

export class PluginLoader {
  /**
   * @param {Object} [options]
   * @param {string} [options.pluginDir] - Primary plugin directory
   * @param {string[]} [options.pluginDirs] - Additional plugin directories
   * @param {string[]} [options.disabled] - Plugin names to disable
   */
  constructor(options = {}) {
    const { pluginDir, pluginDirs, disabled } = options;
    this.registry = new PluginRegistry({
      pluginDir: pluginDir || path.join(os.homedir(), '.bahulam', 'plugins'),
      pluginDirs,
      disabled,
    });
    this.pluginDir = pluginDir || path.join(os.homedir(), '.bahulam', 'plugins');
  }

  /**
   * Load all plugins from registered directories.
   * @returns {PluginRegistry}
   */
  load() {
    this.registry.scan();
    return this.registry;
  }

  /**
   * Load plugins from a specific directory (scans subdirectories).
   * @param {string} dir
   * @returns {PluginRegistry}
   */
  loadFromDirectory(dir) {
    this.registry._scanDir(dir);
    return this.registry;
  }

  /**
   * Clone a plugin from a git repo and load it.
   * @param {string} repoUrl - git repository URL
   * @param {string} [name] - plugin name (default: repo name)
   * @returns {object|null} loaded manifest
   */
  loadFromGit(repoUrl, name) {
    const pluginName = name || repoUrl.split('/').pop()?.replace('.git', '') || 'plugin';
    const targetDir = path.join(this.pluginDir, pluginName);

    try {
      fs.mkdirSync(this.pluginDir, { recursive: true });

      if (fs.existsSync(targetDir)) {
        // Update existing
        execSync('git pull', { cwd: targetDir, stdio: 'pipe' });
      } else {
        // Clone new
        execSync(`git clone --depth 1 ${repoUrl} ${targetDir}`, { stdio: 'pipe' });
      }

      const manifestPath = path.join(targetDir, 'plugin.yaml');
      const altPath = path.join(targetDir, 'plugin.json');
      const exists = fs.existsSync(manifestPath) ? manifestPath : (fs.existsSync(altPath) ? altPath : null);

      if (exists) {
        const { parsePluginManifestFile } = await import('./manifest.mjs');
        const manifest = parsePluginManifestFile(exists);
        if (manifest) {
          this.registry.register(manifest);
          return manifest;
        }
      }
    } catch (err) {
      if (process.env.DEBUG) {
        console.error(`Failed to clone plugin ${repoUrl}: ${err.message}`);
      }
    }

    return null;
  }

  /**
   * Get all installed plugins.
   * @returns {object[]}
   */
  getInstalledPlugins() {
    return this.registry.list();
  }

  /**
   * Get a plugin by name.
   * @param {string} name
   * @returns {object|undefined}
   */
  getPlugin(name) {
    return this.registry.get(name);
  }

  /**
   * Remove a plugin by name.
   * @param {string} name
   * @returns {boolean}
   */
  removePlugin(name) {
    const plugin = this.registry.get(name);
    if (!plugin) return false;

    try {
      if (plugin._dir && fs.existsSync(plugin._dir)) {
        fs.rmSync(plugin._dir, { recursive: true, force: true });
      }
    } catch (err) {
      if (process.env.DEBUG) {
        console.error(`Failed to remove plugin directory ${plugin._dir}: ${err.message}`);
      }
    }

    return this.registry.remove(name);
  }

  /**
   * Get plugin count.
   * @returns {number}
   */
  count() {
    return this.registry.count();
  }
}