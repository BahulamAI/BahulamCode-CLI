import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdoBrokerTransport } from '../src/connectors/azure-devops-broker.mjs';
import { adoPluginDigest, executeHostedTool, loadHostedRuntime } from '../src/connectors/microsoft-teams/hosted-runtime.mjs';
import { createHostedTeamsHandler, activityIdentity } from '../src/connectors/microsoft-teams/hosted-server.mjs';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../awesome-bahulam-plugins/plugins/azure-devops');
const connectionId = '11111111-1111-4111-8111-111111111111';
const definition = { name: 'ado_get_pull_request', tool: './tools/get-pull-request.mjs' };
let captured;
const result = await executeHostedTool({ pluginDir, definition, args: { pull_request_id: 12 }, connectionId,
  invoke: async request => { captured = request; return { id: 12 }; } });
assert.deepEqual(result, { id: 12 });
assert.equal(captured.operation, definition.name);
assert.deepEqual(captured.args, { pull_request_id: 12 });
assert.throws(() => executeHostedTool({ pluginDir, definition: { name: 'run_command', tool: './tools/lib.mjs' } }), /denied/);
assert.throws(() => loadHostedRuntime({ pluginDir, expectedDigest: 'wrong' }), /digest mismatch/);

const transport = createAdoBrokerTransport({ brokerUrl: 'https://broker.example/api/integration-connections/',
  getInvocationAuthorization: async () => ({ identityToken: 'signed-identity', scopeToken: 'signed-scope', runId: 'run-one' }),
  fetchImpl: async (url, options) => {
    assert.equal(options.headers['X-Bahulam-Run'], 'run-one');
    assert.equal(options.redirect, 'error');
    assert.ok(String(url).endsWith(`${connectionId}/execute/`));
    assert.deepEqual(JSON.parse(options.body), { operation: definition.name, arguments: { pull_request_id: 12 } });
    return { ok: true, json: async () => ({ result: { id: 12 } }) };
  } });
assert.deepEqual(await transport({ connectionId, operation: definition.name, args: { pull_request_id: 12 } }), { id: 12 });
assert.throws(() => createAdoBrokerTransport({ brokerUrl: 'http://attacker.example' }), /HTTPS/);
await assert.rejects(transport({ connectionId, operation: 'run_command' }), /denied/);

const run = loadHostedRuntime({ pluginDir, expectedDigest: adoPluginDigest(pluginDir), credentials: {},
  dispatchOverride: async (_event, ctx) => {
    assert.equal(ctx.toolExecutor.listPluginToolSchemas().length, 7);
    assert.deepEqual(await ctx.toolExecutor.execute('run_command', { command: 'env' }), { success: false, output: 'Tool denied.' });
    const output = await ctx.toolExecutor.execute(definition.name, { pull_request_id: 12 });
    assert.deepEqual(output, { success: true, output: { id: 12 } });
    ctx.renderEvent({ type: 'complete', data: { usage: { models: [{ model: 'fixture', input_tokens: 5, output_tokens: 2 }] } } });
    return { dispatched: true, result: { status: 'completed', output: 'PR 12 reviewed' } };
  } });
const completed = await run({ text: 'Read PR 12', sessionId: 'session', connectionId, invoke: transport });
assert.equal(completed.output, 'PR 12 reviewed');
assert.equal(completed.usage.models_breakdown[0].input_tokens, 5);

const activity = { type: 'message', channelId: 'msteams', id: 'message', text: 'Read PR 12',
  from: { aadObjectId: connectionId }, channelData: { tenant: { id: connectionId } },
  conversation: { id: 'personal', conversationType: 'personal' } };
assert.equal(activityIdentity(activity).actor_id, connectionId);
assert.throws(() => activityIdentity({ ...activity, conversation: { id: 'channel', conversationType: 'channel' } }), /personal/);
let actions = [], sent = [];
const handle = createHostedTeamsHandler({ setupUrl: 'https://bahulam.example/setup', runAgent: async () => completed,
  transportFactory: () => transport, platform: async (action, body) => {
    actions.push(action);
    if (action === 'begin') return { run_id: 'run-one', connection_id: connectionId, session_id: 'session' };
    if (action === 'settle') assert.equal(body.usage.models_breakdown[0].input_tokens, 5);
    return {};
  } });
await handle({ activity, send: async text => sent.push(text) });
assert.deepEqual(actions, ['begin', 'settle']); assert.deepEqual(sent, ['PR 12 reviewed']);
const duplicate = createHostedTeamsHandler({ platform: async () => ({ duplicate: true }), runAgent: () => { throw new Error('Must not execute'); } });
await duplicate({ activity, send: () => { throw new Error('Must not resend'); } });
console.log('Hosted ADO worker, transport, tool allowlist, usage and Teams lifecycle checks passed.');
