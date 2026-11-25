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
import { mcpError } from './credentials.mjs';

/**
 * Load and connect MCP servers from settings, registering their tools
 * with the tool executor.
 *
 * @param {object} toolExecutor - the createToolExecutor() instance
 * @param {object} settings - loaded settings (from loadSettings())
 * @param {object} [options]
 * @param {string} [options.pluginName='settings'] - namespace for settings tools
 * @param {object} [options.pluginRegistry] - validated plugin registry whose
 *        manifest-declared MCP servers are loaded through this same client
 * @returns {Promise<{clients: Array, disconnectAll: Function}>}
 */
export async function loadMcpServers(toolExecutor, settings, options = {}) {
    const pluginName = options.pluginName || 'settings';
    const entries = Object.entries(settings?.mcpServers || {}).map(([name, config]) => ({ name, config, plugin: pluginName }));
    for (const entry of (options.pluginRegistry?.listMcpServers?.() || [])) {
        entries.push({ name: entry.name, config: entry.config, plugin: entry.plugin });
    }
    const clients = [];
    const errors = [];

    for (const { name, config, plugin } of entries) {
        if (!config || typeof config !== 'object') continue;
        if (!config.command && !config.url) continue;

        let client;
        try {
            client = new McpClient(config);
            await client.connect();
            const tools = await client.listTools();
            for (const tool of tools) {
                if (toolExecutor.registerMcpTool) {
                    toolExecutor.registerMcpTool(plugin, name, tool.name, client, tool.inputSchema || {}, tool.description || '');
                }
            }
            clients.push({ name, plugin, client });
            if (process.env.MCP_DEBUG) {
                process.stderr.write(`[mcp:settings] ${name}: ${tools.length} tools registered\n`);
            }
        } catch (err) {
            try { await client?.disconnect(); } catch {}
            errors.push({ name, plugin, message: mcpError(err) });
            // One server failure must never block the session.
            if (process.env.MCP_DEBUG) {
                process.stderr.write(`[mcp:settings] ${name} failed: ${mcpError(err)}\n`);
            }
        }
    }

    return {
        clients,
        errors,
        async disconnectAll() {
            for (const { name, plugin, client } of clients) {
                try { toolExecutor?.unregisterMcpServer?.(plugin, name); } catch {}
                try { await client.disconnect(); } catch {}
            }
        },
    };
}
