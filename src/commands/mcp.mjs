/** Portable registrations stay in ~/.claude/settings.json; secrets do not. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { McpCredentialStore, resolveMcpConfig, redactMcpConfig, safeMcpUrl, mcpError, safeMcpError } from '../mcp/credentials.mjs';
import { loginMcp, requireSecureUrl } from '../mcp/oauth.mjs';
import { promptMcpKey } from '../mcp/credential-prompt.mjs';

const settingsFilePath = () => path.join(os.homedir(), '.claude', 'settings.json');
function readSettings() {
    try { return JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw safeMcpError('Cannot read MCP settings; repair the settings file before editing registrations.'); }
}
function writeServer(name, config) {
    // Login can take minutes. Re-read before committing so another command's
    // unrelated settings updates are not replaced by our pre-login snapshot.
    const settings = readSettings();
    settings.mcpServers ||= {};
    if (config) settings.mcpServers[name] = config;
    else delete settings.mcpServers[name];
    const file = settingsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID();
    try {
        fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
}

export function parseMcpArgs(argv) {
    const args = { env: {}, headers: {}, args: [] };
    const positional = [];
    const values = { '--url': 'url', '--command': 'command', '--transport': 'transport', '--client-id': 'clientId', '--scope': 'scope', '--callback-port': 'callbackPort', '--api-key-header': 'apiKeyHeader', '--api-key-prefix': 'apiKeyPrefix' };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (values[flag]) {
            if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw safeMcpError(`Missing value for ${flag}.`);
            args[values[flag]] = argv[++i];
        } else if (['--help', '-h', '--json', '--oauth', '--api-key'].includes(flag)) {
            args[flag === '-h' ? 'help' : flag.slice(2)] = true;
        } else if (['--env', '--header', '--headers'].includes(flag)) {
            const pair = argv[++i] || '';
            const header = flag !== '--env';
            const split = pair.indexOf(header ? ':' : '=');
            if (split < 1) throw safeMcpError('Expected --env NAME=value or --header "Name: value".');
            args[header ? 'headers' : 'env'][pair.slice(0, split).trim()] = pair.slice(split + 1).trim();
        } else if (flag === '--args') {
            while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args.args.push(argv[++i]);
        } else if (flag.startsWith('-')) throw safeMcpError('Unknown MCP option. Run bahulam mcp --help.');
        else positional.push(flag);
    }
    [args.action, args.name] = positional;
    if (positional.length > 2) throw safeMcpError('Unexpected MCP argument. --api-key prompts securely; do not pass the key as an argument.');
    if (args.oauth && args['api-key']) throw safeMcpError('Choose --oauth or --api-key.');
    if (args.callbackPort !== undefined && (!/^\d+$/.test(args.callbackPort) || +args.callbackPort < 1024 || +args.callbackPort > 65535)) throw safeMcpError('Callback port must be between 1024 and 65535.');
    return args;
}

export async function handleMcpCommand(argv) {
    try { return await runMcpCommand(parseMcpArgs(argv)); }
    catch (error) { throw safeMcpError(mcpError(error)); }
}

async function runMcpCommand(args) {
    if (args.help || !args.action) {
        process.stdout.write(`Bahulam MCP servers\n\n  add <name> --command <cmd> [--args ...] [--env NAME=value]\n  add <name> --url <url> [--transport http|sse] [--oauth | --api-key]\n  add <name> --url <url> --header 'Authorization: Bearer \${API_KEY}'\n  login <name> [--api-key]       Browser OAuth login or masked API-key entry\n  logout <name>                Delete locally saved credentials\n  list [--json]                Show registrations (secrets redacted)\n  test <name>                  Connect and discover tools; never execute tools\n  remove <name>                Unregister the server\n\nOAuth options: --client-id <id> --scope <scope> --callback-port <port>\nAPI-key options: --api-key-header <name> --api-key-prefix <prefix>\nRun these inside Bahulam with !bahulam mcp ...\n`);
        return;
    }
    const settings = readSettings();
    const servers = settings.mcpServers ||= {};
    if (['list', 'ls'].includes(args.action)) {
        const redacted = Object.fromEntries(Object.entries(servers).map(([name, config]) => [name, redactMcpConfig(config)]));
        if (args.json) process.stdout.write(JSON.stringify({ servers: redacted }) + '\n');
        else {
            process.stdout.write('MCP servers\n');
            for (const [name, config] of Object.entries(redacted)) process.stdout.write(`  ${name} · ${config.command || config.url} · ${config.auth?.type || 'configured headers / none'}\n`);
            if (!Object.keys(servers).length) process.stdout.write('  No servers registered.\n');
        }
        return;
    }
    if (!args.name || !/^[\w.-]+$/.test(args.name) || ['__proto__', 'constructor', 'prototype'].includes(args.name)) throw safeMcpError('A server name using letters, numbers, dots, hyphens or underscores is required.');
    let config = Object.hasOwn(servers, args.name) ? servers[args.name] : undefined;
    const success = message => process.stdout.write(args.json ? JSON.stringify({ ok: true, name: args.name, message, ...(args.action === 'add' ? { config: redactMcpConfig(config) } : {}) }) + '\n' : message + '\n');
    const configureAuth = target => {
        if (args['api-key']) target.auth = { type: 'api-key', header: args.apiKeyHeader || target.auth?.header || 'Authorization', prefix: args.apiKeyPrefix ?? target.auth?.prefix ?? 'Bearer ' };
        else target.auth = { ...target.auth, type: 'oauth', ...(args.clientId ? { clientId: args.clientId } : {}), ...(args.scope ? { scope: args.scope } : {}), ...(args.callbackPort ? { callbackPort: +args.callbackPort } : {}) };
        if (Object.keys(target.headers || {}).some(key => key.toLowerCase() === (target.auth.header || 'Authorization').toLowerCase())) throw safeMcpError('Remove the configured authentication header before using stored credentials.');
    };
    if (args.action === 'add') {
        if (Boolean(args.command) === Boolean(args.url)) throw safeMcpError('Specify exactly one of --command or --url.');
        config = args.url ? { url: args.url } : { command: args.command, args: args.args };
        if (args.transport) {
            if (!['stdio', 'http', 'streamable-http', 'sse', 'websocket'].includes(args.transport)) throw safeMcpError('Unsupported MCP transport.');
            config.transport = args.transport;
        }
        if (Object.keys(args.env).length) config.env = args.env;
        if (Object.keys(args.headers).length) config.headers = args.headers;
        if (args.oauth || args['api-key']) {
            if (!config.url) throw safeMcpError('Browser OAuth and stored API keys require a remote HTTP server.');
            configureAuth(config);
            const resolved = resolveMcpConfig(config);
            requireSecureUrl(resolved.url);
            if (args['api-key']) new McpCredentialStore(resolved.url).write({ apiKey: await promptMcpKey() });
        }
        servers[args.name] = config;
        writeServer(args.name, config);
        success(`Registered ${args.name}. Run bahulam mcp ${args.oauth ? 'login' : 'test'} ${args.name}.`);
        return;
    }
    if (!config) throw safeMcpError('MCP server is not registered. Run bahulam mcp list.');
    if (['remove', 'rm'].includes(args.action)) {
        writeServer(args.name, null);
        success('Server removed. Saved credentials are retained; use logout before removal to delete them.'); return;
    }
    if (args.action === 'logout') {
        if (!config.url) throw safeMcpError('This server has no stored remote credentials.');
        new McpCredentialStore(resolveMcpConfig({ url: config.url }).url).clear();
        success('Local credentials deleted. Active connections must be reconnected; provider-side grants are not revoked.'); return;
    }
    if (args.action === 'login') {
        if (!config.url) throw safeMcpError('Browser login requires a remote HTTP server.');
        if (config.auth?.type === 'api-key') args['api-key'] = true;
        configureAuth(config);
        const resolved = resolveMcpConfig(config);
        requireSecureUrl(resolved.url);
        if (args['api-key']) new McpCredentialStore(resolved.url).write({ apiKey: await promptMcpKey() });
        else {
            process.stderr.write(`Opening browser to sign in to ${safeMcpUrl(resolved.url)}…\n`);
            await loginMcp(resolved);
        }
        writeServer(args.name, config);
        success('Credentials saved. Run mcp test to verify; restart the Bahulam session to load newly registered tools.'); return;
    }
    if (args.action === 'test') {
        const { McpClient } = await import('../mcp/client.mjs');
        const client = new McpClient(config);
        try { await client.connect(); const tools = await client.listTools(); success(`Connected to ${args.name}; ${tools.length} tools available.`); }
        finally { await client.disconnect().catch(() => {}); }
        return;
    }
    throw safeMcpError('Unknown MCP action. Run bahulam mcp --help.');
}
