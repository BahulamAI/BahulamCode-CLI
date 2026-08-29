/**
 * Agent Parser — parses agent definitions from native YAML, JSON, and Markdown.
 *
 * JSON format:
 * {
 *   "name": "my-agent",
 *   "description": "Does things",
 *   "model": "claude-sonnet-4-6",
 *   "tools": ["Bash", "Read", "Write"],
 *   "hooks": { ... },
 *   "prompt": "You are a specialized agent..."
 * }
 *
 * Markdown format (YAML frontmatter):
 * ---
 * name: my-agent
 * description: Does things
 * model: claude-sonnet-4-6
 * tools: [Bash, Read, Write]
 * ---
 * You are a specialized agent...
 */

/**
 * Parse an agent definition from file content.
 * @param {string} content - file content
 * @param {string} ext - file extension (.yaml, .yml, .json, or .md)
 * @returns {object} agent definition
 */
export function parseAgentDefinition(content, ext) {
    if (ext === '.yaml' || ext === '.yml') {
        return parseYamlAgent(content);
    }
    if (ext === '.json') {
        return parseJsonAgent(content);
    }
    if (ext === '.md') {
        return parseMarkdownAgent(content);
    }
    throw new Error(`Unsupported agent format: ${ext}`);
}

function parseJsonAgent(content) {
    const data = JSON.parse(content);
    return normalizeAgent(data);
}

function parseMarkdownAgent(content) {
    const { frontmatter, body } = parseFrontmatter(content);
    return normalizeAgent({ ...frontmatter, prompt: body });
}

function parseYamlAgent(content) {
    const config = parseKeplerSubAgentYaml(content);
    return normalizeAgent({
        raw_config: config,
        apiVersion: config.apiVersion,
        kind: config.kind,
        ...(config.metadata || {}),
        ...(config.agent?.model ? { model: config.agent.model } : {}),
        ...(config.agent?.models ? { models: config.agent.models } : {}),
        max_iterations: config.agent?.max_iterations,
        max_tokens: config.agent?.max_tokens,
        prompt: config.agent?.system_prompt || '',
        tools: config.tools || [],
    });
}

function parseScalar(value) {
    const raw = String(value || '').trim();
    if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
    if (raw.startsWith('[') && raw.endsWith(']')) {
        return raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    return raw;
}

function parseKeplerSubAgentYaml(content) {
    const root = {};
    const lines = String(content || '').split(/\r?\n/);
    let section = root;
    let sectionName = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        if (!line.startsWith(' ')) {
            const match = line.match(/^([^:]+):\s*(.*)$/);
            if (!match) continue;
            const key = match[1].trim();
            const value = match[2].trim();
            if (value === '') {
                root[key] = key === 'tools' ? [] : {};
                section = root[key];
                sectionName = key;
            } else {
                root[key] = parseScalar(value);
                section = root;
                sectionName = null;
            }
            continue;
        }

        if (sectionName === 'tools') {
            const item = line.trim().match(/^-\s*(.+)$/);
            if (item) section.push(parseScalar(item[1]));
            continue;
        }

        const nested = line.match(/^\s{2}([^:]+):\s*(.*)$/);
        if (!nested || typeof section !== 'object' || Array.isArray(section)) continue;
        const key = nested[1].trim();
        const value = nested[2].trim();
        if (value === '|') {
            const block = [];
            const baseIndent = (lines[i + 1]?.match(/^(\s*)/)?.[1]?.length ?? 4);
            while (i + 1 < lines.length) {
                const next = lines[i + 1];
                if (!next.trim()) {
                    block.push('');
                    i++;
                    continue;
                }
                const indent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
                if (indent < baseIndent) break;
                block.push(next.slice(baseIndent));
                i++;
            }
            section[key] = block.join('\n').trimEnd();
        } else if (value === '') {
            section[key] = {};
        } else {
            section[key] = parseScalar(value);
        }
    }
    return root;
}

/**
 * Parse YAML-like frontmatter from markdown.
 * Simple key-value parser (no full YAML dependency).
 */
function parseFrontmatter(content) {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: content };
    }

    const yamlBlock = match[1];
    const body = match[2].trim();
    const frontmatter = {};

    for (const line of yamlBlock.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();

        // Parse arrays: [a, b, c]
        if (value.startsWith('[') && value.endsWith(']')) {
            value = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
        }
        // Parse booleans
        else if (value === 'true') value = true;
        else if (value === 'false') value = false;
        // Parse numbers
        else if (/^\d+$/.test(value)) value = parseInt(value, 10);

        frontmatter[key] = value;
    }

    return { frontmatter, body };
}

function normalizeAgent(data) {
    const config = data.raw_config || null;
    const metadata = config?.metadata || {};
    const agent = config?.agent || {};
    return {
        slug: data.slug || data.id || metadata.slug || metadata.name || data.name || 'unnamed',
        id: data.id || data.slug || metadata.slug || metadata.name || data.name || 'unnamed',
        name: data.name || metadata.name || 'unnamed',
        description: data.description || metadata.description || '',
        role: data.role || metadata.role || 'specialist',
        model: data.model || agent.model || null,
        models: data.models && typeof data.models === 'object' ? data.models : {},
        tools: Array.isArray(data.tools) ? data.tools : Array.isArray(config?.tools) ? config.tools : [],
        capabilities: Array.isArray(data.capabilities) ? data.capabilities : Array.isArray(metadata.capabilities) ? metadata.capabilities : [],
        domains: Array.isArray(data.domains) ? data.domains : Array.isArray(metadata.domains) ? metadata.domains : [],
        hooks: data.hooks || {},
        prompt: data.prompt || agent.system_prompt || '',
        maxTokens: data.max_tokens || agent.max_tokens || 4096,
        maxTurns: data.maxTurns || data.max_turns || data.max_iterations || agent.max_iterations || 10,
        max_iterations: data.max_iterations || data.maxTurns || data.max_turns || agent.max_iterations || 10,
        can_delegate: data.can_delegate ?? false,
        can_be_delegated_to: data.can_be_delegated_to ?? true,
        temperature: data.temperature || undefined,
        raw_config: config,
        config,
    };
}
