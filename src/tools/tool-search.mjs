/**
 * ToolSearch Tool — deferred tool loading / search.
 *
 * Allows the agent to discover and load tools that are not
 * in the default set. Supports searching MCP servers and
 * deferred tool definitions.
 */

export const ToolSearchTool = {
    name: 'ToolSearch',
    description: 'Search for and load deferred tools by name or keyword.',
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Tool name or search keywords',
            },
            max_results: {
                type: 'number',
                description: 'Maximum results to return (default: 5)',
            },
        },
        required: ['query'],
    },

    // Will be set by the registry when MCP tools are available
    _mcpTools: [],
    _registry: null,

    validateInput(input) {
        return input.query ? [] : ['query is required'];
    },

    async call(input) {
        const query = input.query.toLowerCase();
        const maxResults = input.max_results || 5;
        const matches = [];

        // Search MCP tools
        for (const tool of this._mcpTools) {
            const name = (tool.name || '').toLowerCase();
            const desc = (tool.description || '').toLowerCase();
            if (name.includes(query) || desc.includes(query)) {
                matches.push({
                    name: tool.name,
                    description: tool.description,
                    source: 'mcp',
                });
            }
        }

        // Search registry tools
        if (this._registry) {
            for (const tool of this._registry.list()) {
                const name = (tool.name || '').toLowerCase();
                const desc = (tool.description || '').toLowerCase();
                if (name.includes(query) || desc.includes(query)) {
                    matches.push({
                        name: tool.name,
                        description: tool.description,
                        source: 'builtin',
                    });
                }
            }
        }

        if (matches.length === 0) {
            return `No tools found matching "${input.query}"`;
        }

        const limited = matches.slice(0, maxResults);
        return limited.map(m =>
            `[${m.source}] ${m.name}: ${m.description}`
        ).join('\n');
    },
};
