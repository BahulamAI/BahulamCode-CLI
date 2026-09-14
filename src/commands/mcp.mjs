/**
 * `bahulam mcp` — manage MCP server registrations.
 *
 *   bahulam mcp add <name> --command <cmd> [--args ...] [--env KEY=VAL ...]
 *   bahulam mcp add <name> --url <url> [--headers ...]
 *   bahulam mcp remove <name>
 *   bahulam mcp list
 *   bahulam mcp test <name>
 *
 * MCP servers are stored in ~/.claude/settings.json under mcpServers,
 * matching the Claude Desktop / Cursor / Cline portable format.
 * The settings loader chain reads this file at startup, and the MCP
 * loader (src/mcp/loader.mjs) spawns and registers tools from it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function settingsFilePath() {
    return path.join(os.homedir(), '.claude', 'settings.json');
}

function loadSettingsFile() {
    const file = settingsFilePath();
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return {};
    }
}

function saveSettingsFile(data) {
    const file = settingsFilePath();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function parseArgs(argv) {
    const parsed = {
        subcommand: null,
        name: null,
        command: null,
        args: [],
        url: null,
        env: {},
        headers: {},
        transport: null,
        help: false,
        json: false,
    };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--help': case '-h': parsed.help = true; break;
            case '--json': parsed.json = true; break;
            case '--command': parsed.command = argv[++i]; break;
            case '--url': parsed.url = argv[++i]; break;
            case '--transport': parsed.transport = argv[++i]; break;
            case '--env': {
                const pair = argv[++i] || '';
                const eq = pair.indexOf('=');
                if (eq > 0) parsed.env[pair.slice(0, eq)] = pair.slice(eq + 1);
                break;
            }
            case '--header': case '--headers': {
                const pair = argv[++i] || '';
                const eq = pair.indexOf(':');
                if (eq > 0) parsed.headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
                break;
            }
            case '--args': {
                // Collect remaining positional args until next --flag
                while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                    parsed.args.push(argv[++i]);
                }
                break;
            }
            default:
                if (!arg.startsWith('-')) positional.push(arg);
                break;
        }
    }
    parsed.subcommand = positional.shift() || null;
    parsed.name = positional.shift() || null;
    return parsed;
}

export async function handleMcpCommand(argv) {
    const args = parseArgs(argv);

    if (args.help || !args.subcommand) {
        process.stderr.write(`
  ${BOLD}bahulam mcp <subcommand>${RESET}

  Manage MCP (Model Context Protocol) server registrations.

  ${BOLD}Subcommands:${RESET}

    ${CYAN}add${RESET} <name> ${DIM}--command <cmd> [--args a b c] [--env KEY=VAL ...]${RESET}
         Register a stdio MCP server (spawns a child process).

    ${CYAN}add${RESET} <name> ${DIM}--url <url> [--header "Key: Val" ...]${RESET}
         Register a remote MCP server (SSE, WebSocket, or Streamable HTTP).
         Transport is auto-detected: ws:// → WebSocket, /sse → SSE, else sHTTP.

    ${CYAN}remove${RESET} <name>          Unregister an MCP server.
    ${CYAN}list${RESET}                   List all registered MCP servers.
    ${CYAN}test${RESET} <name>            Connect, list tools, and call one.

  ${BOLD}Examples:${RESET}

    ${DIM}# Supabase MCP (stdio)${RESET}
    ${CYAN}bahulam mcp add supabase --command npx --args -y @supabase/mcp-server-supabase --env SUPABASE_ACCESS_TOKEN=sbp_xxx${RESET}

    ${DIM}# Remote SSE server${RESET}
    ${CYAN}bahulam mcp add myapi --url https://api.example.com/sse --header "Authorization: Bearer token123"${RESET}

    ${DIM}# List and test${RESET}
    ${CYAN}bahulam mcp list${RESET}
    ${CYAN}bahulam mcp test supabase${RESET}

  ${BOLD}Config location:${RESET} ${settingsFilePath()}

`);
        if (!args.subcommand) process.exit(1);
        return;
    }

    switch (args.subcommand) {
        case 'add': return handleAdd(args);
        case 'remove': case 'rm': return handleRemove(args);
        case 'list': case 'ls': return handleList(args);
        case 'test': return handleTest(args);
        default:
            process.stderr.write(`${RED}✗${RESET} Unknown subcommand: ${args.subcommand}\n`);
            process.stderr.write(`Run ${CYAN}bahulam mcp --help${RESET} for usage.\n`);
            process.exit(1);
    }
}

function handleAdd(args) {
    if (!args.name) {
        process.stderr.write(`${RED}✗${RESET} Server name required. Usage: bahulam mcp add <name> --command <cmd> | --url <url>\n`);
        process.exit(1);
    }
    if (!args.command && !args.url) {
        process.stderr.write(`${RED}✗${RESET} Either --command or --url is required.\n`);
        process.exit(1);
    }

    const settings = loadSettingsFile();
    if (!settings.mcpServers) settings.mcpServers = {};

    const config = {};
    if (args.command) {
        config.command = args.command;
        if (args.args.length > 0) config.args = args.args;
    }
    if (args.url) config.url = args.url;
    if (Object.keys(args.env).length > 0) config.env = args.env;
    if (Object.keys(args.headers).length > 0) config.headers = args.headers;
    if (args.transport) config.transport = args.transport;

    settings.mcpServers[args.name] = config;
    saveSettingsFile(settings);

    if (args.json) {
        process.stdout.write(JSON.stringify({ ok: true, name: args.name, config }) + '\n');
        return;
    }

    const type = config.command ? 'stdio' : 'remote';
    const endpoint = config.command || config.url;
    process.stderr.write(`${GREEN}✓${RESET} Registered MCP server ${BOLD}${args.name}${RESET} (${type}: ${endpoint})\n`);
    process.stderr.write(`  ${DIM}config${RESET}  ${settingsFilePath()}\n`);
    process.stderr.write(`  ${DIM}test${RESET}   ${CYAN}bahulam mcp test ${args.name}${RESET}\n\n`);
}

function handleRemove(args) {
    if (!args.name) {
        process.stderr.write(`${RED}✗${RESET} Server name required. Usage: bahulam mcp remove <name>\n`);
        process.exit(1);
    }
    const settings = loadSettingsFile();
    if (!settings.mcpServers?.[args.name]) {
        process.stderr.write(`${YELLOW}!${RESET} No MCP server named "${args.name}" is registered.\n`);
        process.exit(1);
    }
    delete settings.mcpServers[args.name];
    saveSettingsFile(settings);

    if (args.json) {
        process.stdout.write(JSON.stringify({ ok: true, removed: args.name }) + '\n');
        return;
    }
    process.stderr.write(`${GREEN}✓${RESET} Removed MCP server ${BOLD}${args.name}${RESET}\n`);
}

function handleList(args) {
    const settings = loadSettingsFile();
    const servers = settings.mcpServers || {};
    const names = Object.keys(servers);

    if (names.length === 0) {
        process.stderr.write(`${DIM}No MCP servers registered.${RESET}\n`);
        process.stderr.write(`Add one: ${CYAN}bahulam mcp add <name> --command <cmd>${RESET}\n\n`);
        return;
    }

    if (args.json) {
        process.stdout.write(JSON.stringify({ servers }) + '\n');
        return;
    }

    process.stderr.write(`${BOLD}MCP Servers${RESET} (${names.length}):\n`);
    for (const name of names) {
        const cfg = servers[name];
        const type = cfg.command ? 'stdio' : 'remote';
        const endpoint = cfg.command || cfg.url || 'unknown';
        const toolCount = cfg._tools ? ` (${cfg._tools} tools)` : '';
        process.stderr.write(`  ${CYAN}${name.padEnd(20)}${RESET} ${type.padEnd(7)} ${endpoint}${toolCount}\n`);
    }
    process.stderr.write(`\n${DIM}Config: ${settingsFilePath()}${RESET}\n\n`);
}

async function handleTest(args) {
    if (!args.name) {
        process.stderr.write(`${RED}✗${RESET} Server name required. Usage: bahulam mcp test <name>\n`);
        process.exit(1);
    }

    const settings = loadSettingsFile();
    const config = settings.mcpServers?.[args.name];
    if (!config) {
        process.stderr.write(`${RED}✗${RESET} No MCP server named "${args.name}" is registered.\n`);
        process.exit(1);
    }

    process.stderr.write(`${DIM}Connecting to ${args.name}…${RESET}\n`);

    try {
        const { McpClient } = await import('../mcp/client.mjs');
        const { loadMcpServers } = await import('../mcp/loader.mjs');

        // Use the loader to handle env expansion
        const fakeExecutor = {
            registerMcpTool: () => true,
            unregisterMcpServer: () => 0,
        };
        const mcp = await loadMcpServers(fakeExecutor, { mcpServers: { [args.name]: config } });

        if (mcp.clients.length === 0) {
            process.stderr.write(`${RED}✗${RESET} Failed to connect to "${args.name}".\n`);
            process.stderr.write(`${DIM}Check that the command/URL is correct and any required env vars are set.${RESET}\n`);
            process.exit(1);
        }

        const client = mcp.clients[0].client;
        const tools = client.tools;

        process.stderr.write(`${GREEN}✓${RESET} Connected! Server: ${BOLD}${client.serverInfo?.serverInfo?.name || args.name}${RESET}\n`);
        process.stderr.write(`  ${DIM}tools${RESET}  ${tools.length}\n`);
        for (const t of tools) {
            process.stderr.write(`         ${CYAN}${t.name}${RESET} — ${(t.description || '').slice(0, 70)}\n`);
        }

        // Try calling the first tool that looks like a list/query
        const listTool = tools.find(t =>
            /list|query|search|get|fetch/i.test(t.name) && !/delete|update|create|insert|drop/i.test(t.name)
        );

        if (listTool) {
            process.stderr.write(`\n${DIM}Testing tool: ${listTool.name}…${RESET}\n`);
            const result = await client.callTool(listTool.name, {});
            const preview = String(result).slice(0, 500);
            process.stderr.write(`${GREEN}✓${RESET} Result: ${preview}${preview.length >= 500 ? '…' : ''}\n`);
        }

        await mcp.disconnectAll();
        process.stderr.write(`\n${GREEN}✓${RESET} Test passed.\n\n`);
    } catch (err) {
        process.stderr.write(`${RED}✗${RESET} Test failed: ${err.message}\n`);
        process.exit(1);
    }
}
