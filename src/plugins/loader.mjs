/**
 * Plugin Loader — load plugins from directory, git, or npm.
 *
 * Plugins can provide: tools, agents, skills, hooks.
 * Plugin format: a directory with a plugin.json manifest.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

export class PluginLoader {
    /**
     * @param {string} [pluginDir] - directory to scan for plugins
     */
    constructor(pluginDir) {
        this.pluginDir = pluginDir ||
            path.join(os.homedir(), '.claude', 'plugins');
        this.plugins = new Map();
    }

    /**
     * Load plugins from the plugin directory.
     * @returns {Array<object>} loaded plugin manifests
     */
    async loadFromDirectory(dir) {
        const targetDir = dir || this.pluginDir;
        const loaded = [];

        try {
            if (!fs.existsSync(targetDir)) return loaded;

            const entries = fs.readdirSync(targetDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const manifestPath = path.join(targetDir, entry.name, 'plugin.json');
                if (!fs.existsSync(manifestPath)) continue;

                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                    manifest._dir = path.join(targetDir, entry.name);
                    manifest._name = entry.name;
                    this.plugins.set(manifest.name || entry.name, manifest);
                    loaded.push(manifest);
                } catch {
                    // Skip malformed plugins
                }
            }
        } catch {
            // Directory not readable
        }

        return loaded;
    }

    /**
     * Clone a plugin from a git repo and load it.
     * @param {string} repoUrl - git repository URL
     * @param {string} [name] - plugin name (default: repo name)
     * @returns {object|null} loaded manifest
     */
    async loadFromGit(repoUrl, name) {
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

            const manifestPath = path.join(targetDir, 'plugin.json');
            if (fs.existsSync(manifestPath)) {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                manifest._dir = targetDir;
                manifest._name = pluginName;
                this.plugins.set(manifest.name || pluginName, manifest);
                return manifest;
            }
        } catch {
            // Git operation failed
        }

        return null;
    }

    /**
     * Get all installed plugins.
     * @returns {Array<object>}
     */
    getInstalledPlugins() {
        return [...this.plugins.values()];
    }

    /**
     * Get a plugin by name.
     * @param {string} name
     * @returns {object|undefined}
     */
    getPlugin(name) {
        return this.plugins.get(name);
    }

    /**
     * Remove a plugin by name.
     * @param {string} name
     * @returns {boolean}
     */
    removePlugin(name) {
        const plugin = this.plugins.get(name);
        if (!plugin) return false;

        try {
            if (plugin._dir && fs.existsSync(plugin._dir)) {
                fs.rmSync(plugin._dir, { recursive: true, force: true });
            }
        } catch {
            // Best effort
        }

        return this.plugins.delete(name);
    }

    /**
     * Get plugin count.
     * @returns {number}
     */
    count() {
        return this.plugins.size;
    }
}
