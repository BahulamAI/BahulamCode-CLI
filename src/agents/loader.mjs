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
        this.aliases = new Map();
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
                    this._register(agent, filePath);
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
            const agents = plugin.config?.agents || [];
            for (const agentDef of agents) {
                const slug = agentDef.slug || agentDef.name || '';
                if (!slug) continue;
                this._register({
                    ...agentDef,
                    slug,
                    source: `plugin:${plugin.metadata?.name || 'unknown'}`,
                    source_scope: 'plugin',
                }, null);
            }
        }
        return this;
    }

    _register(agent, sourcePath = null) {
        if (!agent) return null;
        const slug = normalizeKey(agent.slug || agent.id || agent.name);
        if (!slug) return null;
        const aliases = [
            slug,
            normalizeKey(agent.name),
            normalizeKey(agent.id),
        ].filter(Boolean);

        // Earlier search paths have higher precedence: project beats global,
        // and both beat plugin-provided agents.
        if (aliases.some(alias => this.aliases.has(alias))) return null;

        const stored = { ...agent, slug: agent.slug || slug, ...(sourcePath ? { source: sourcePath } : {}) };
        this.agents.set(slug, stored);
        for (const alias of aliases) this.aliases.set(alias, slug);
        return stored;
    }

    /**
     * Get an agent definition by name.
     * @param {string} name
     * @returns {object|null}
     */
    get(name) {
        const key = normalizeKey(name);
        const slug = this.aliases.get(key) || key;
        return this.agents.get(slug) || null;
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
        return Boolean(this.get(name));
    }
}

function normalizeKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
