import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { cliInfo, CLI_INFO_SCHEMA } from '../src/core/cli-info.mjs';
import { createToolExecutor } from '../src/core/tool-executor.mjs';
import { LocalAgent } from '../src/core/local-agent.mjs';
import { BahulamStreamClient } from '../src/core/stream-client.mjs';
import { instructionContext } from '../src/core/context-envelope.mjs';
import { classify } from '../src/core/risk-tier.mjs';

const originalHome = process.env.BAHULAM_HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-cli-info-'));
process.env.BAHULAM_HOME = home;
const executor = createToolExecutor({ deferProjectIndex: true });
test.after(() => {
    if (originalHome === undefined) delete process.env.BAHULAM_HOME; else process.env.BAHULAM_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
});

test('installed CLI knowledge is executable, versioned, read-only and includes safe MCP instructions', async () => {
    const result = await executor.execute('bahulam_cli_info', { topic: 'mcp' });
    assert.equal(result.success, true);
    const info = JSON.parse(result.output);
    assert.equal(info.version, createRequire(import.meta.url)('../package.json').version);
    assert.ok(info.mcp.oauth.some(command => command.includes('mcp login')));
    assert.ok(info.mcp.guidance.some(line => line.includes('Never request a key in chat')));
    assert.equal(info.input, undefined);
    assert.equal(classify('bahulam_cli_info'), 'read');
    assert.equal((await executor.execute('bahulam_cli_info', { topic: 'invalid' })).success, false);
});

test('local and override prompts direct CLI questions to the installed knowledge tool', () => {
    for (const systemPromptOverride of [null, 'Custom agent']) {
        const agent = new LocalAgent({ toolExecutor: executor, systemPromptOverride });
        assert.equal(agent._buildToolDefs().filter(tool => tool.name === CLI_INFO_SCHEMA.name).length, 1);
        assert.match(agent._buildSystemPrompt({}), /use bahulam_cli_info/);
    }
    assert.ok(executor.listPluginToolSchemas().some(tool => tool.name === CLI_INFO_SCHEMA.name));
    const context = instructionContext({}, executor.getAgentContext());
    assert.match(context.project_context.prompt_block, /installed|Installed/);
    assert.match(context.project_context.prompt_block, /bahulam_cli_info/);
    assert.ok(cliInfo('input').input.examples.some(example => example.startsWith('!bahulam mcp')));
});

test('remote route advertises the executable CLI info tool without a plugin or backend change', async () => {
    const previousFetch = globalThis.fetch;
    let body;
    globalThis.fetch = async (_url, options) => {
        body = JSON.parse(options.body);
        return new Response('event: complete\ndata: {"success":true}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    };
    try {
        const client = new BahulamStreamClient({ baseUrl: 'http://example.invalid', token: 'fixture', toolExecutor: executor });
        for await (const _ of client.execute('How do I connect an OAuth MCP server?', instructionContext({}, executor.getAgentContext()))) {}
        assert.equal(body.client_tools.filter(tool => tool.name === CLI_INFO_SCHEMA.name).length, 1);
        assert.match(body.context.project_context.prompt_block, /bahulam_cli_info/);
    } finally { globalThis.fetch = previousFetch; }
});
