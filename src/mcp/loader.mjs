/**
 * MCP Settings Loader — bridges settings-based mcpServers to the tool executor.
 *
 * The agent-relay path already spawns MCP servers from plugin manifests.
 * This module provides the same capability for CLI/REPL/headless mode by
 * reading mcpServers from the settings chain (~/.claude/settings.json etc.)
 * and optionally from ~/.bahulam/config.json.
 *
 * Usage:
 *   import { loadMcpServers } from '../mcp/loader.mjs';
 *   const mcpClients = await loadMcpServers(toolExecutor, settings);
 *   // ... later ...
 *   await mcpClients.disconnectAll();
 */

import { McpClient } from './client.mjs';

/**
 * Recursively expand ${VAR} patterns in a config object using process.env.
 * Matches the behavior in agent-relay.mjs _expandEnvInMcpConfig.
 * @param {*} value
 * @returns {*}
 */
function expandEnv(value) {
    if (typeof value === 'string') {
        return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
    }
    if (Array.isArray(value)) return value.map(expandEnv);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, expandEnv(v)]),
        );
    }
    return value;
}

/**
 * Load and connect MCP servers from settings, registering their tools
 * with the tool executor.
 *
 * @param {object} toolExecutor - the createToolExecutor() instance
 * @param {object} settings - loaded settings (from loadSettings())
 * @param {object} [options]
 * @param {string} [options.pluginName='settings'] - namespace for tool registration
 * @returns {Promise<{clients: Array, disconnectAll: Function}>}
 */
export async function loadMcpServers(toolExecutor, settings, options = {}) {
    const pluginName = options.pluginName || 'settings';
    const servers = settings?.mcpServers || {};
    const clients = [];

    for (const [name, config] of Object.entries(servers)) {
        if (!config || typeof config !== 'object') continue;
        if (!config.command && !config.url) continue;

        try {
            // Merge the config's env block into process.env BEFORE expanding
            // ${VAR} patterns in args/env. This matches the Claude Desktop
            // convention: the env block sets vars for the spawned process
            // AND for ${VAR} expansion in the same config.
            if (config.env && typeof config.env === 'object') {
                for (const [k, v] of Object.entries(config.env)) {
                    if (typeof v === 'string' && !process.env[k]) {
                        process.env[k] = v;
                    }
                }
            }
            const expanded = expandEnv(config);
            const client = new McpClient(expanded);
            await client.connect();
            const tools = await client.listTools();
            for (const tool of tools) {
                if (toolExecutor.registerMcpTool) {
                    toolExecutor.registerMcpTool(pluginName, name, tool.name, client, tool.inputSchema || {});
                }
            }
            clients.push({ name, client });
            if (process.env.MCP_DEBUG) {
                process.stderr.write(`[mcp:settings] ${name}: ${tools.length} tools registered\n`);
            }
        } catch (err) {
            // One server failure must never block the session.
            if (process.env.MCP_DEBUG) {
                process.stderr.write(`[mcp:settings] ${name} failed: ${err.message}\n`);
            }
        }
    }

    return {
        clients,
        async disconnectAll() {
            for (const { name, client } of clients) {
                try { toolExecutor?.unregisterMcpServer?.(pluginName, name); } catch {}
                try { await client.disconnect(); } catch {}
            }
        },
    };
}
