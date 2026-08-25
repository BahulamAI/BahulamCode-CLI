/**
 * Workflow Loader — loads single-agent workflow YAML files from .bahulam/workflows/
 *
 * Workflow YAML files follow the same structure as Bahulam SubAgent YAML:
 *   metadata: { id, name, description, icon, tags }
 *   agent: { system_prompt, model, max_iterations }
 *   tools: { include: [...], exclude: [...] }
 *   params: { ... }
 *   channel: "server"
 *
 * These are submitted to POST /api/templates (backend object = template).
 * The user-facing term is "workflow" everywhere.
 */

import fs from 'fs';
import path from 'path';
import { parseAgentDefinition } from './parser.mjs';

/**
 * Load a single workflow YAML file and return an API-ready payload.
 * @param {string} filePath - absolute path to .yaml file
 * @returns {object} payload ready for POST /api/templates
 */
export function loadWorkflowFromFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.yaml', '.yml'].includes(ext)) {
        throw new Error(`Unsupported workflow format: ${ext}. Use .yaml or .yml`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseAgentDefinition(content, ext);

    return workflowToTemplatePayload(parsed, filePath);
}

/**
 * Scan a directory for .yaml/.yml files and load each one.
 * @param {string} dir - directory path
 * @returns {Array<{file: string, payload: object}>}
 */
export function loadWorkflowsFromDir(dir) {
    const results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (ext !== '.yaml' && ext !== '.yml') continue;
            const filePath = path.join(dir, entry.name);
            try {
                const payload = loadWorkflowFromFile(filePath);
                results.push({ file: filePath, payload });
            } catch (err) {
                if (process.env.DEBUG) {
                    console.error(`[workflow-loader] Failed to load ${filePath}: ${err.message}`);
                }
            }
        }
    } catch {
        // Directory does not exist
    }
    return results;
}

/**
 * Convert a parsed agent definition into the API payload expected by POST /api/templates.
 *
 * The parsed agent from parseAgentDefinition() has this shape:
 *   { name, description, raw_config: { metadata, agent, tools, params, channel }, ... }
 *
 * The API expects:
 *   { slug, name, description, category, tags, icon, system_prompt, model,
 *     max_iterations, tools_include, tools_exclude, params, channel }
 *
 * @param {object} agent - parsed agent definition
 * @param {string} [sourcePath] - optional file path for slug derivation
 * @returns {object} API payload
 */
export function workflowToTemplatePayload(agent, sourcePath) {
    const raw = agent.raw_config || {};
    const metadata = raw.metadata || {};
    const agentConfig = raw.agent || {};

    // Derive slug: metadata.id > filename stem > agent name
    let slug = metadata.id || '';
    if (!slug && sourcePath) {
        slug = path.basename(sourcePath, path.extname(sourcePath));
    }
    if (!slug) {
        slug = (agent.name || 'unnamed').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    }

    // Tools: include/exclude
    const tools = raw.tools || {};
    let toolsInclude = [];
    let toolsExclude = [];
    if (Array.isArray(tools)) {
        toolsInclude = tools;
    } else {
        toolsInclude = tools.include || [];
        toolsExclude = tools.exclude || [];
    }

    // Params
    const params = raw.params || {};

    return {
        slug,
        name: metadata.name || agent.name || slug,
        description: metadata.description || agent.description || '',
        category: metadata.category || 'custom',
        tags: metadata.tags || [],
        icon: metadata.icon || 'code',
        system_prompt: agentConfig.system_prompt || agent.prompt || '',
        model: agentConfig.model || agent.model || null,
        max_iterations: agentConfig.max_iterations || agent.max_iterations || 20,
        tools_include: toolsInclude,
        tools_exclude: toolsExclude,
        params,
        channel: raw.channel || 'server',
    };
}
