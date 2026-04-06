/**
 * ReadMcpResource Tool — read a resource from an MCP server.
 *
 * MCP resources are identified by URI and can contain text, JSON,
 * or binary data. This tool reads text/JSON resources.
 */

export const ReadMcpResourceTool = {
    name: 'ReadMcpResource',
    description: 'Read a resource from an MCP server by URI.',
    inputSchema: {
        type: 'object',
        properties: {
            uri: {
                type: 'string',
                description: 'Resource URI (e.g., "file:///path" or "mcp://server/resource")',
            },
            server: {
                type: 'string',
                description: 'MCP server name (if URI does not specify)',
            },
        },
        required: ['uri'],
    },

    // Set by the MCP integration layer
    _mcpClients: null,

    validateInput(input) {
        return input.uri ? [] : ['uri is required'];
    },

    async call(input) {
        if (!this._mcpClients || this._mcpClients.length === 0) {
            return 'No MCP servers connected. Configure MCP servers in settings.';
        }

        for (const client of this._mcpClients) {
            try {
                const result = await client.readResource(input.uri);
                if (result) {
                    if (typeof result === 'string') return result;
                    if (result.contents && Array.isArray(result.contents)) {
                        return result.contents
                            .map(c => c.text || JSON.stringify(c))
                            .join('\n');
                    }
                    return JSON.stringify(result, null, 2);
                }
            } catch {
                // Try next client
            }
        }

        return `Resource not found: ${input.uri}`;
    },
};
