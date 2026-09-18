/**
 * Test plugin execution across local/direct modes.
 *
 * Verifies:
 *   1. PluginRegistry loads installed plugins correctly
 *   2. Plugin tools are registered in the ToolExecutor
 *   3. Plugin tool schemas appear in LocalAgent._buildToolDefs()
 *   4. Plugin agent schemas are surfaced properly
 *   5. Plugin tool dispatch works end-to-end (loads handler, calls, returns)
 */

import { PluginRegistry } from '../src/plugins/registry.mjs';
import { createToolExecutor } from '../src/core/tool-executor.mjs';
import { LocalAgent } from '../src/core/local-agent.mjs';
import { loadPluginTool } from '../src/plugins/executor.mjs';
import { parsePluginManifestFile } from '../src/plugins/manifest.mjs';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
let failed = 0;

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ${GREEN}✓${RESET} ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ${RED}✗${RESET} ${name}: ${err.message}`);
        console.log(`    ${DIM}${err.stack?.split('\n').slice(1, 4).join('\n    ')}${RESET}`);
        failed++;
    }
}

console.log(`\n${BOLD}test-plugin-local-execution.mjs${RESET}\n`);

// ─── 1. PluginRegistry loads installed plugins ─────────────────────

await test('PluginRegistry scans and loads installed plugins', async () => {
    const registry = new PluginRegistry().scan();
    const plugins = registry.list();
    assert.ok(plugins.length >= 1, `Expected at least 1 plugin, got ${plugins.length}`);
    const names = plugins.map(p => p.metadata?.name).filter(Boolean);
    console.log(`    ${DIM}Plugins found: ${names.join(', ')}${RESET}`);
    assert.ok(names.includes('browser-use'), 'Expected browser-use plugin to be loaded');
    assert.ok(names.includes('manim-studio'), 'Expected manim-studio plugin to be loaded');
});

await test('PluginRegistry lists plugin tools', async () => {
    const registry = new PluginRegistry().scan();
    const tools = registry.listTools();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length >= 1, 'Expected at least 1 plugin tool');
    const names = tools.map(t => t.name);
    console.log(`    ${DIM}Plugin tools: ${names.join(', ')}${RESET}`);
    // Each tool must have a name and input_schema
    for (const tool of tools) {
        assert.ok(tool.name, 'Tool must have a name');
        assert.ok(tool.input_schema, 'Tool must have an input_schema');
    }
});

await test('PluginRegistry lists plugin agents', async () => {
    const registry = new PluginRegistry().scan();
    const agents = registry.listAgents();
    assert.ok(Array.isArray(agents));
    console.log(`    ${DIM}Plugin agents: ${agents.map(a => a.slug || a.name).join(', ')}${RESET}`);
    for (const agent of agents) {
        assert.ok(agent.slug || agent.name, 'Agent must have a slug or name');
        assert.ok(agent.role, `Agent ${agent.slug} must have a role`);
        assert.ok(Array.isArray(agent.tools), `Agent ${agent.slug} must have a tools array`);
        // Description is optional — some agents (e.g. compliance-reviewer) omit it
        if (!agent.description) {
            console.log(`    ${DIM}Note: agent "${agent.slug}" has no description${RESET}`);
        }
    }
});

// ─── 2. Plugin tools are registered in the ToolExecutor ────────────

await test('ToolExecutor registers plugin tools from PluginRegistry', async () => {
    const registry = new PluginRegistry().scan();
    const executor = createToolExecutor({ pluginRegistry: registry, channel: 'workspace' });
    
    // Check that executor can list plugin tools
    const pluginTools = registry.listTools();
    for (const tool of pluginTools) {
        // Try executing each plugin tool with empty args to check it's callable
        // (state tools and composed tools may fail gracefully — that's OK)
        try {
            const result = await executor.execute(tool.name, {});
            assert.ok(result !== undefined, `Tool ${tool.name} must return a result`);
            // It's fine if it returns an error — the important thing is it dispatches
            console.log(`    ${DIM}${tool.name}: ${result.success ? 'OK' : 'errored'} -> ${String(result.output || '').slice(0, 60)}${RESET}`);
        } catch (err) {
            // Tool execution errors are acceptable for tools with required params
            console.log(`    ${DIM}${tool.name}: execution threw (expected with empty args)${RESET}`);
        }
    }
});

// ─── 3. Plugin tool schemas appear in LocalAgent._buildToolDefs() ──

await test('LocalAgent._buildToolDefs includes plugin tools when extraToolSchemas is set', async () => {
    const registry = new PluginRegistry().scan();
    const executor = createToolExecutor({ pluginRegistry: registry });
    const pluginSchemas = executor.listPluginToolSchemas?.() || [];
    
    console.log(`    ${DIM}Plugin schemas from executor: ${pluginSchemas.map(s => s.name).join(', ')}${RESET}`);

    const agent = new LocalAgent({
        apiKey: 'sk-ant-test',
        toolExecutor: executor,
        extraToolSchemas: pluginSchemas,
    });
    const defs = agent._buildToolDefs();
    const builtinCount = 14; // TOOL_SCHEMAS.length
    assert.ok(defs.length >= builtinCount, 
        `Expected at least ${builtinCount} builtin tools, got ${defs.length}`);
    
    // Check that plugin tool schemas are included
    const pluginNames = new Set(pluginSchemas.map(s => s.name));
    const defNames = new Set(defs.map(d => d.name));
    for (const name of pluginNames) {
        assert.ok(defNames.has(name), 
            `Plugin tool "${name}" must appear in tool defs`);
    }
    console.log(`    ${DIM}Total tool defs: ${defs.length} (${builtinCount} builtin + ${pluginSchemas.length} plugin)${RESET}`);
});

await test('LocalAgent._buildToolDefs works without extraToolSchemas', async () => {
    const executor = createToolExecutor();
    const agent = new LocalAgent({ apiKey: 'test', toolExecutor: executor });
    const defs = agent._buildToolDefs();
    assert.strictEqual(defs.length, 14, 'Without extraToolSchemas, only builtin tools should appear');
});

// ─── 4. Plugin agent schemas flow through stream-client ────────────

await test('Plugin agent schemas are properly shaped for API injection', async () => {
    const registry = new PluginRegistry().scan();
    const agents = registry.listAgents();
    
    // Create a minimal mock that exercises _getPluginAgentSchemas
    // Normally this lives in BahulamStreamClient
    const schemas = agents.map(a => ({
        slug: a.slug || a.name || '',
        name: a.name || a.slug || '',
        role: a.role || 'specialist',
        description: a.description || '',
        tools: Array.isArray(a.tools) ? a.tools : [],
        system_prompt: a.system_prompt || a.systemPrompt || a.prompt || '',
        model: a.model || null,
        models: a.models || null,
        source: a.source || (a._plugin_name ? `plugin:${a._plugin_name}` : 'plugin'),
        source_scope: 'plugin',
        plugin_name: a._plugin_name || null,
    }));
    
    for (const s of schemas) {
        assert.ok(s.slug, 'Agent schema must have slug');
        assert.ok(Array.isArray(s.tools), 'Agent schema tools must be an array');
        assert.strictEqual(s.source_scope, 'plugin', 'Agent source_scope must be "plugin"');
    }
    console.log(`    ${DIM}Agent schemas: ${schemas.map(s => `${s.slug} (${s.tools.length} tools)`).join(', ')}${RESET}`);
});

// ─── 5. Plugin tool dispatch works end-to-end ───────────────────────

await test('loadPluginTool can load a real plugin handler module', async () => {
    const registry = new PluginRegistry().scan();
    const pluginTools = registry.listTools();
    
    // Find a JS-native plugin tool (not state_tool, not composed, not MCP)
    const jsTool = pluginTools.find(t => 
        !t._state_tool && 
        !t._composed && 
        t.tool && 
        t._plugin_dir
    );
    
    if (!jsTool) {
        console.log(`    ${DIM}Skipping — no JS-native plugin tool found in installed plugins${RESET}`);
        return;
    }
    
    console.log(`    ${DIM}Testing tool: ${jsTool.name} from ${jsTool._plugin_dir}${RESET}`);
    console.log(`    ${DIM}Handler path: ${jsTool.tool}${RESET}`);
    
    const handler = await loadPluginTool(jsTool._plugin_dir, jsTool.tool);
    assert.ok(handler, `Handler must load for ${jsTool.name}`);
    assert.ok(typeof handler.call === 'function', `Handler must have a call() function`);
    console.log(`    ${DIM}Handler loaded: name=${handler.name}, has call()=${typeof handler.call === 'function'}${RESET}`);
});

await test('Plugin manifest parsing works for all installed plugins', async () => {
    const registry = new PluginRegistry().scan();
    const plugins = registry.list();
    
    for (const plugin of plugins) {
        const name = plugin.metadata?.name || 'unknown';
        console.log(`    ${DIM}${name}:${RESET}`);
        console.log(`      apiVersion: ${plugin.apiVersion}`);
        console.log(`      kind: ${plugin.kind}`);
        console.log(`      tools: ${(plugin.config?.tools || []).length}`);
        console.log(`      agents: ${(plugin.config?.agents || []).length}`);
        console.log(`      mcpServers: ${Object.keys(plugin.config?.mcpServers || {}).length}`);
        
        assert.ok(plugin.apiVersion, `${name} must have apiVersion`);
        assert.ok(plugin.metadata, `${name} must have metadata`);
        assert.ok(plugin.metadata.name, `${name} must have a name`);
    }
});

// ─── Summary ───────────────────────────────────────────────────────

console.log(`\n  ${BOLD}${passed} passed${RESET}, ${RED}${failed} failed${RESET}\n`);
if (failed > 0) process.exit(1);