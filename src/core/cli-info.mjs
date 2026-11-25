import { createRequire } from 'node:module';

const version = createRequire(import.meta.url)('../../package.json').version;

export const CLI_INFO_SCHEMA = {
    name: 'bahulam_cli_info',
    description: 'Read authoritative instructions for this installed Bahulam CLI: version, MCP browser OAuth and API-key registration, direct ! commands, and skill invocation. No credentials or account data are read. Use bahulam_info for backend/account/model information.',
    input_schema: { type: 'object', properties: { topic: { type: 'string', enum: ['all', 'mcp', 'input', 'version'] } }, additionalProperties: false },
};

export const CLI_CAPABILITIES = Object.freeze({
    version, info_tool: CLI_INFO_SCHEMA.name,
    mcp_browser_oauth: true, mcp_token_refresh: true, mcp_masked_api_key: true,
    direct_commands: true, skill_prefix: '$',
});

export const CLI_INFO_PROMPT = `Installed Bahulam CLI ${version}: use bahulam_cli_info for CLI commands, MCP setup/authentication, ! direct commands and $ skills. Its versioned client information takes precedence over generic backend help for CLI features. Use bahulam_info for account, provider and billing questions. Never ask users to paste API keys into chat or URLs; direct them to the masked --api-key prompt or an environment reference. Browser login and masked prompts require the user's interactive terminal, not the agent's shell tool.`;

export function cliInfo(topic = 'all') {
    if (!['all', 'mcp', 'input', 'version'].includes(topic)) throw new Error('Unknown CLI information topic. Use all, mcp, input or version.');
    const result = { product: 'Bahulam Code', version, source: 'installed CLI package', capabilities: CLI_CAPABILITIES };
    if (topic === 'all' || topic === 'mcp') result.mcp = {
        oauth: ['bahulam mcp add <name> --url <server-url> --oauth', 'bahulam mcp login <name>', 'bahulam mcp test <name>'],
        api_key: 'bahulam mcp add <name> --url <server-url> --api-key',
        env_header: "bahulam mcp add <name> --url <server-url> --header 'Authorization: Bearer ${MCP_API_KEY}'",
        management: ['bahulam mcp list --json', 'bahulam mcp logout <name>', 'bahulam mcp remove <name>'],
        guidance: [
            'Confirm the provider supports OAuth and use its documented OAuth endpoint. A public URL alone does not authenticate.',
            'Login opens the local browser using PKCE and a loopback callback. Runtime startup never opens a browser; it reuses and refreshes saved tokens.',
            'Use --client-id and --callback-port for a pre-registered public OAuth client when required. Use --scope for explicit scopes.',
            'API keys must be entered by the user in the masked prompt or supplied through an environment variable. Never request a key in chat or embed it in a URL.',
            'The default API-key header is Authorization: Bearer. Override with --api-key-header and --api-key-prefix if the provider requires another scheme.',
            'Credentials are local private files, not an encrypted keychain. Configuration output and provider errors are redacted.',
            'Test initializes and discovers tools without invoking them. Restart the session to register newly added tools with the agent.',
            'Logout removes local credentials, not the provider-side grant. Run logout before remove if credentials should also be deleted.',
        ],
    };
    if (topic === 'all' || topic === 'input') result.input = {
        prefixes: { '/': 'CLI commands', '$': 'Invoke a named installed skill; read its instructions using skill_view', '!': 'Execute a local command directly, outside agent context' },
        examples: ['!bahulam mcp login <name>', '!bahulam mcp add <name> --url <server-url> --api-key', '$skill-name task description'],
        guidance: [
            'The user types ! commands in the composer; ! is not a shell command prefix for agent tool calls.',
            'Node, Rust inline and Rust full-screen hand the terminal to the child command. Press Enter afterward to return to the previous view.',
            'Direct commands and their output are not submitted to the model. During an agent turn they queue until the turn finishes.',
            '!bahulam mcp uses the currently running installation and preserves quoted environment references.',
        ],
    };
    return result;
}
