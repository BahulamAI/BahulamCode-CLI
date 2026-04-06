/**
 * Agent Loader — loads custom agent definitions from .claude/agents/
 *
 * Supports two formats:
 * - JSON: .claude/agents/*.json
 * - Markdown with YAML frontmatter: .claude/agents/*.md
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
            path.join(cwd, '.claude', 'agents'),
            path.join(process.env.HOME || '', '.claude', 'agents'),
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
                if (ext !== '.json' && ext !== '.md') continue;

                const filePath = path.join(dir, entry.name);
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const agent = parseAgentDefinition(content, ext);
                    if (agent && agent.name) {
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
