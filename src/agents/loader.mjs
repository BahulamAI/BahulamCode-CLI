/**
 * Agent Loader — loads custom agent definitions from .bahulam/agents/
 *
 * Supports two formats:
 * - YAML: .bahulam/agents/*.yaml / *.yml (native Bahulam SubAgent config)
 * - JSON: .bahulam/agents/*.json
 * - Markdown with YAML frontmatter: .bahulam/agents/*.md
 *
 * Agent definitions specify: name, description, model, tools, hooks, prompt.
 */

import fs from 'fs';
import path from 'path';
import { parseAgentDefinition } from './parser.mjs';

export class AgentLoader {
    constructor() {
        this.agents = new Map();
        this.searchPaths = [];
    }

    /**
     * Load agents from standard directories.
     * @param {string} [cwd] - project working directory
     */
    load(cwd = process.cwd()) {
        this.searchPaths = [
            path.join(cwd, '.bahulam', 'agents'),
            path.join(process.env.HOME || '', '.bahulam', 'agents'),
        ];

        for (const dir of this.searchPaths) {
            this._loadFromDir(dir);
        }

        return this;
    }

    _loadFromDir(dir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                const ext = path.extname(entry.name);
                if (!['.yaml', '.yml', '.json', '.md'].includes(ext)) continue;

                const filePath = path.join(dir, entry.name);
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const agent = parseAgentDefinition(content, ext);
                    if (agent && agent.name && !this.agents.has(agent.name)) {
                        this.agents.set(agent.name, { ...agent, source: filePath });
                    }
                } catch (err) {
                    if (process.env.DEBUG) {
                        console.error(`Failed to load agent ${filePath}: ${err.message}`);
                    }
                }
            }
        } catch {
            // Directory does not exist
        }
    }

    /**
     * Load agents from plugin manifests.
     * Plugin agents have lower priority than project .bahulam/agents agents.
     * @param {object[]} plugins - List of plugin manifests
     * @returns {this}
     */
    loadFromPlugins(plugins) {
        if (!Array.isArray(plugins)) return this;
        for (const plugin of plugins) {
            const agents = plugin.spec?.agents || [];
            for (const agentDef of agents) {
                const slug = agentDef.slug || agentDef.name || '';
                if (!slug) continue;
                // Project agents take precedence — skip if already registered
                if (this.agents.has(slug)) continue;
                this.agents.set(slug, {
                    ...agentDef,
                    slug,
                    source: `plugin:${plugin.metadata?.name || 'unknown'}`,
                    source_scope: 'plugin',
                });
            }
        }
        return this;
    }

    /**
     * Get an agent definition by name.
     * @param {string} name
     * @returns {object|null}
     */
    get(name) {
        return this.agents.get(name) || null;
    }

    /**
     * List all loaded agents.
     * @returns {Array<object>}
     */
    list() {
        return [...this.agents.values()];
    }

    /**
     * Check if an agent exists.
     * @param {string} name
     * @returns {boolean}
     */
    has(name) {
        return this.agents.has(name);
    }
}
