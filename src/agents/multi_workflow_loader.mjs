/**
 * Multi-Agent Workflow Loader — loads multi-agent workflow YAML files
 * from .bahulam/workflows/ and produces API payloads for POST /api/workflows.
 *
 * Multi-agent workflow YAML schema:
 *
 * ```yaml
 * metadata:
 *   name: Code Review Pipeline
 *   description: Sequential review by specialist agents
 *
 * orchestration:
 *   pattern: sequential  # sequential | parallel
 *   instruction: "Review the PR"
 *
 * agents:
 *   - slug: code-explorer
 *     label: Explore Codebase
 *     config:
 *       depth: full
 *   - slug: security-reviewer
 *     label: Security Audit
 *     config: {}
 *
 * edges:
 *   - source: trigger
 *     target: code-explorer
 *   - source: code-explorer
 *     target: security-reviewer
 *   - source: security-reviewer
 *     target: output
 *
 * global_params:
 *   repo_url: ""
 *   pr_number: ""
 * ```
 *
 * The loader converts this into a graph structure matching the canvas
 * format: { nodes: [...], edges: [...] } with node types trigger/agent/output.
 */

import fs from 'fs';
import path from 'path';

/**
 * Load a multi-agent workflow YAML file and return an API-ready payload.
 * @param {string} filePath - absolute path to .yaml file
 * @returns {object} payload ready for POST /api/workflows
 */
export function loadMultiWorkflowFromFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.yaml', '.yml'].includes(ext)) {
        throw new Error(`Unsupported workflow format: ${ext}. Use .yaml or .yml`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseWorkflowYaml(content);

    if (!parsed) {
        throw new Error('Empty or invalid YAML file');
    }

    return multiWorkflowToApiPayload(parsed, filePath);
}

/**
 * Convert a parsed multi-agent workflow YAML into the API payload.
 *
 * @param {object} parsed - parsed YAML content
 * @param {string} sourcePath - file path for slug derivation
 * @returns {object} { name, description, graph, global_params, pattern }
 */
export function multiWorkflowToApiPayload(parsed, sourcePath) {
    const metadata = parsed.metadata || {};
    const orchestration = parsed.orchestration || {};
    const agents = parsed.agents || [];
    const edges = parsed.edges || [];
    const globalParams = parsed.global_params || {};

    // Validate
    if (!metadata.name && !sourcePath) {
        throw new Error('Workflow must have a name in metadata or a filename');
    }
    if (!Array.isArray(agents) || agents.length === 0) {
        throw new Error('Workflow must define at least one agent in the agents list');
    }
    if (!Array.isArray(edges) || edges.length === 0) {
        throw new Error('Workflow must define at least one edge connecting nodes');
    }

    const name = metadata.name || path.basename(sourcePath, path.extname(sourcePath));
    const description = metadata.description || '';

    // Build graph nodes
    // 1. Trigger node
    const nodes = [
        {
            id: 'trigger',
            type: 'trigger',
            position: { x: 0, y: 120 },
            data: {
                label: 'Manual Run',
                icon: 'trigger',
                status: 'idle',
                nodeType: 'trigger',
                triggerType: 'manual',
            },
        },
    ];

    // 2. Agent nodes from the agents list
    for (const agent of agents) {
        const slug = agent.slug || agent.name || 'agent';
        const label = agent.label || slug;
        // Position agents in a vertical column or horizontal row
        const index = agents.indexOf(agent);
        nodes.push({
            id: slug,
            type: 'agent',
            position: { x: 250, y: 120 + index * 160 },
            data: {
                label,
                subtitle: '',
                icon: 'agent',
                status: 'idle',
                nodeType: 'agent',
                agent_source: 'user',
                agent_slug: slug,
                user_agent_slug: slug,
                model: agent.model || 'auto',
                tools: agent.tools || [],
                config: {
                    ...(agent.config || {}),
                    agent_slug: slug,
                    user_agent_slug: slug,
                },
            },
        });
    }

    // 3. Output node
    nodes.push({
        id: 'output',
        type: 'output',
        position: { x: 500, y: 120 + (agents.length - 1) * 80 },
        data: {
            label: 'Results',
            icon: 'review',
            status: 'idle',
            nodeType: 'output',
            outputType: 'display',
        },
    });

    // Build graph edges
    // Use explicit edges from YAML, or auto-wire: trigger → first agent → ... → last agent → output
    let graphEdges;
    if (edges.length > 0) {
        graphEdges = edges.map((e, i) => ({
            id: `e-${i}`,
            source: e.source,
            target: e.target,
        }));
    } else {
        // Auto-wire sequential
        graphEdges = [];
        const agentIds = agents.map(a => a.slug || a.name || 'agent');
        graphEdges.push({ id: 'e-trigger-first', source: 'trigger', target: agentIds[0] });
        for (let i = 0; i < agentIds.length - 1; i++) {
            graphEdges.push({ id: `e-${i}-${i + 1}`, source: agentIds[i], target: agentIds[i + 1] });
        }
        graphEdges.push({ id: 'e-last-output', source: agentIds[agentIds.length - 1], target: 'output' });
    }

    const graph = {
        nodes,
        edges: graphEdges,
    };

    const pattern = orchestration.pattern || 'sequential';

    return {
        name,
        description,
        graph,
        global_params: globalParams,
        orchestration_pattern: pattern,
        pattern,
    };
}

function stripComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') {
            quote = quote === ch ? null : quote || ch;
        }
        if (ch === '#' && !quote) return line.slice(0, i);
    }
    return line;
}

function parseScalar(value) {
    const raw = stripComment(String(value || '')).trim();
    if (raw === '{}') return {};
    if (raw === '[]') return [];
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw.slice(1, -1);
    }
    if (raw.startsWith('[') && raw.endsWith(']')) {
        return raw.slice(1, -1).split(',').map(s => parseScalar(s)).filter(v => v !== '');
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return raw;
}

function assignNested(target, key, value) {
    if (key.includes('.')) {
        const parts = key.split('.');
        let cursor = target;
        for (const part of parts.slice(0, -1)) {
            cursor[part] ||= {};
            cursor = cursor[part];
        }
        cursor[parts[parts.length - 1]] = value;
        return;
    }
    target[key] = value;
}

function parseWorkflowYaml(content) {
    const root = {};
    const lines = String(content || '').split(/\r?\n/);
    let section = null;
    let currentItem = null;
    let currentNested = null;

    for (const originalLine of lines) {
        if (!originalLine.trim() || originalLine.trimStart().startsWith('#')) continue;
        const line = stripComment(originalLine);
        if (!line.trim()) continue;

        const top = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (top) {
            const key = top[1];
            const value = top[2].trim();
            section = key;
            currentItem = null;
            currentNested = null;
            if (value) root[key] = parseScalar(value);
            else root[key] = key === 'agents' || key === 'edges' ? [] : {};
            continue;
        }

        if (!section) continue;

        const listItem = line.match(/^\s{2}-\s*([^:]+):\s*(.*)$/);
        if (listItem && Array.isArray(root[section])) {
            currentItem = {};
            currentNested = null;
            assignNested(currentItem, listItem[1].trim(), parseScalar(listItem[2]));
            root[section].push(currentItem);
            continue;
        }

        const listScalar = line.match(/^\s{2}-\s*(.+)$/);
        if (listScalar && Array.isArray(root[section])) {
            root[section].push(parseScalar(listScalar[1]));
            continue;
        }

        const nestedField = line.match(/^\s{4}([^:]+):\s*(.*)$/);
        if (nestedField && currentNested) {
            assignNested(currentNested, nestedField[1].trim(), parseScalar(nestedField[2]));
            continue;
        }

        const objectField = line.match(/^\s{2}([^:]+):\s*(.*)$/);
        if (objectField) {
            const key = objectField[1].trim();
            const value = objectField[2].trim();
            if (currentItem) {
                if (!value) {
                    currentItem[key] = {};
                    currentNested = currentItem[key];
                } else {
                    assignNested(currentItem, key, parseScalar(value));
                    currentNested = null;
                }
            } else if (typeof root[section] === 'object' && !Array.isArray(root[section])) {
                assignNested(root[section], key, parseScalar(value));
            }
            continue;
        }
    }

    return root;
}

/**
 * Scan a directory for multi-agent workflow YAML files.
 * @param {string} dir - directory path
 * @returns {Array<{file: string, payload: object}>}
 */
export function loadMultiWorkflowsFromDir(dir) {
    const results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (ext !== '.yaml' && ext !== '.yml') continue;
            const filePath = path.join(dir, entry.name);
            try {
                const payload = loadMultiWorkflowFromFile(filePath);
                results.push({ file: filePath, payload });
            } catch (err) {
                if (process.env.DEBUG) {
                    console.error(`[multi-workflow-loader] Failed to load ${filePath}: ${err.message}`);
                }
            }
        }
    } catch {
        // Directory does not exist
    }
    return results;
}
