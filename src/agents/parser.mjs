/**
 * Agent Parser — parses agent definitions from JSON and Markdown formats.
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
 * @param {string} ext - file extension (.json or .md)
 * @returns {object} agent definition
 */
export function parseAgentDefinition(content, ext) {
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
    return {
        name: data.name || 'unnamed',
        description: data.description || '',
        model: data.model || null,
        tools: Array.isArray(data.tools) ? data.tools : [],
        hooks: data.hooks || {},
        prompt: data.prompt || '',
        maxTurns: data.maxTurns || data.max_turns || 10,
        temperature: data.temperature || undefined,
    };
}
