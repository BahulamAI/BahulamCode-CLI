import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolExecutor } from '../src/core/tool-executor.mjs';
import { BahulamStreamClient } from '../src/core/stream-client.mjs';
import { LocalAgent } from '../src/core/local-agent.mjs';
import { createScopedToolExecutor } from '../src/terminal/agents.mjs';

const previousHome = process.env.BAHULAM_HOME;
const previousSkip = process.env.BAHULAM_SKIP_AUTO_REGISTER;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-mcp-discovery-'));
process.env.BAHULAM_HOME = home;
process.env.BAHULAM_SKIP_AUTO_REGISTER = 'true';
test.after(() => {
    if (previousHome === undefined) delete process.env.BAHULAM_HOME; else process.env.BAHULAM_HOME = previousHome;
    if (previousSkip === undefined) delete process.env.BAHULAM_SKIP_AUTO_REGISTER; else process.env.BAHULAM_SKIP_AUTO_REGISTER = previousSkip;
    fs.rmSync(home, { recursive: true, force: true });
});

const schema = { type: 'object', properties: { channel: { type: 'string' } }, required: ['channel'] };
function fixture() {
    const executor = createToolExecutor({ deferProjectIndex: true });
    const calls = [];
    const client = { callTool: async (name, args) => { calls.push({ name, args }); return 'fixture result'; } };
    executor.registerMcpTool('settings', 'postiz', 'list_channels', client, schema, 'List connected social channels');
    return { executor, calls, client };
}

test('all 26 discovered MCP schemas reach the remote model request without credentials', async () => {
    const { executor, calls, client: mcp } = fixture();
    for (let i = 1; i < 26; i++) executor.registerMcpTool('settings', 'postiz', `operation_${i}`, mcp, schema, `Operation ${i}`);
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response('event: complete\ndata: {"success":true}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    };
    try {
        const client = new BahulamStreamClient({ baseUrl: 'http://example.invalid', token: 'fixture', toolExecutor: executor });
        for await (const _ of client.execute('Which channels are connected?')) {}
        const tools = request.client_tools.filter(tool => tool.name.startsWith('mcp_'));
        assert.equal(tools.length, 26);
        assert.equal(new Set(tools.map(tool => tool.name)).size, 26);
        for (const tool of tools) {
            assert.match(tool.name, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
            assert.deepEqual(tool.input_schema, schema);
        }
        assert.equal(tools[0].description, 'List connected social channels');
        assert.equal(calls.length, 0, 'schema advertisement does not execute tools');
    } finally { globalThis.fetch = originalFetch; }
});

test('local loop advertises MCP tools and resolves model aliases after approval', async () => {
    const { executor, calls } = fixture();
    const tool = executor.listMcpToolSchemas()[0];
    const approvals = [];
    const agent = new LocalAgent({ toolExecutor: executor, maxTurns: 2,
        extraToolSchemas: executor.listPluginToolSchemas(),
        approvalManager: { check: async name => { approvals.push(name); return { approved: true }; } },
    });
    let turns = 0;
    agent._callLLM = async (_system, messages, tools) => {
        assert.equal(tools.filter(item => item.name === tool.name).length, 1);
        assert.deepEqual(Object.keys(tools.find(item => item.name === tool.name)).sort(), ['description', 'input_schema', 'name']);
        if (++turns === 1) return { content: [{ type: 'tool_use', id: 'mcp-call', name: tool.name, input: { channel: 'demo' } }], stopReason: 'tool_use', usage: null };
        assert.ok(messages.some(message => message.content?.some?.(block => block.type === 'tool_use' && block.name === tool.name)), 'model history retains the advertised alias');
        return { content: [{ type: 'text', text: 'Finished' }], stopReason: 'end_turn', usage: null };
    };
    for await (const _ of agent.execute('Inspect channels')) {}
    assert.deepEqual(approvals, ['postiz.list_channels']);
    assert.deepEqual(calls, [{ name: 'list_channels', args: { channel: 'demo' } }]);
});

test('approved remote callbacks resolve aliases and cancelled requests do not execute', async () => {
    const { executor, calls } = fixture();
    const alias = executor.listMcpToolSchemas()[0].name;
    const client = new BahulamStreamClient({ baseUrl: 'http://example.invalid', toolExecutor: executor });
    client._cancelled = true;
    const denied = await client._handleToolRequest({ tool: alias, args: { channel: 'demo' }, call_id: 'denied' });
    assert.equal(denied.data.success, false);
    assert.equal(calls.length, 0);
    client._cancelled = false;
    const allowed = await client._handleToolRequest({ tool: alias, args: { channel: 'demo' }, call_id: 'allowed' });
    assert.equal(allowed.data.success, true);
    assert.deepEqual(calls, [{ name: 'list_channels', args: { channel: 'demo' } }]);
});

test('local and remote approval prompts use canonical MCP names and denial executes nothing', async () => {
    const { executor, calls } = fixture();
    const name = executor.listMcpToolSchemas()[0].name;
    const checks = [];
    const approval = { check: async tool => { checks.push(tool); return { approved: false, reason: 'fixture denial' }; } };
    const remote = new BahulamStreamClient({ baseUrl: 'http://example.invalid', toolExecutor: executor, approvalManager: approval });
    const decision = await remote._handleApprovalRequired({ tool_id: 'denied', tool: name, args: {} });
    assert.match(decision.data.message, /Denied postiz.list_channels/);
    const local = new LocalAgent({ toolExecutor: executor, maxTurns: 1,
        extraToolSchemas: executor.listPluginToolSchemas(), approvalManager: approval });
    local._callLLM = async () => ({ content: [{ type: 'tool_use', id: 'denied', name, input: {} }], stopReason: 'tool_use', usage: null });
    for await (const _ of local.execute('Inspect channels')) {}
    assert.deepEqual(checks, ['postiz.list_channels', 'postiz.list_channels']);
    assert.equal(calls.length, 0);
});

test('MCP aliases preserve sub-agent allowlists and scoped advertisement', async () => {
    const { executor, calls, client } = fixture();
    executor.registerMcpTool('settings', 'postiz', 'publish', client, schema, 'Publish a post');
    const [read, write] = executor.listMcpToolSchemas();
    const scoped = createScopedToolExecutor(executor, { name: 'reader', tools: ['postiz.list_channels'] });
    assert.deepEqual(scoped.listMcpToolSchemas().map(tool => tool.name), [read.name]);
    assert.equal((await scoped.execute(write.name, {})).success, false);
    assert.equal(calls.length, 0);
    assert.equal((await scoped.execute(read.name, { channel: 'demo' })).success, true);
    const stream = new BahulamStreamClient({ baseUrl: 'http://example.invalid', toolExecutor: executor });
    const context = { sub_agent: { slug: 'reader', tools: ['postiz.list_channels'] } };
    assert.deepEqual(stream._getClientAgentToolSchemas(context).map(tool => ({ name: tool.name, allowed: tool.allowed_agents })), [{ name: read.name, allowed: ['reader'] }]);
    assert.ok(!stream._getUnclaimedPluginToolSchemas(context).some(tool => tool.name === read.name));
});

test('long and punctuation-heavy names stay unique; disconnect removes aliases and schemas', async () => {
    const { executor, client } = fixture();
    for (const name of ['a.b', 'a_b', 'long_'.repeat(40)]) executor.registerMcpTool('settings', 'other', name, client, schema);
    const tools = executor.listMcpToolSchemas();
    assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
    for (const tool of tools) assert.match(tool.name, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
    const alias = tools[0].name;
    executor.unregisterMcpServer('settings', 'postiz');
    assert.ok(!executor.listMcpToolSchemas().some(tool => tool.name === alias));
    assert.equal((await executor.execute(alias, {})).success, false);
});

test('plugin agent declarations and scoped schemas use the same model-compatible names', () => {
    const { executor } = fixture();
    const alias = executor.listMcpToolSchemas()[0].name;
    const client = new BahulamStreamClient({ baseUrl: 'http://example.invalid',
        toolExecutor: { ...executor, listRunnables: () => [{ slug: 'social-reader', source_scope: 'plugin' }] },
        pluginRegistry: {
            listTools: () => [],
            listAgents: () => [{ slug: 'social-reader', tools: ['postiz.list_channels'], _plugin_name: 'social' }],
        },
    });
    const agents = client._getPluginAgentSchemas();
    assert.deepEqual(agents[0].tools, [alias]);
    assert.deepEqual(client._getUnclaimedPluginToolSchemas({}, agents), []);
    assert.deepEqual(client._getClientAgentToolSchemas({}, agents).map(tool => ({ name: tool.name, agents: tool.allowed_agents })),
        [{ name: alias, agents: ['social-reader'] }]);
});
