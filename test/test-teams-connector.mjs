import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAzureDevOpsConnection } from '../src/connectors/azure-devops.mjs';
import { createTeamsHandler } from '../src/connectors/microsoft-teams/handler.mjs';
import { resolveBinding, scopedState } from '../src/connectors/microsoft-teams/bindings.mjs';
import { loadRuntime } from '../src/connectors/microsoft-teams/runtime.mjs';
import { dispatch } from '../src/orchestration/dispatch.mjs';
import { makePluginState } from '../src/plugins/state.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-teams-test-'));
const previousHome = process.env.BAHULAM_HOME;
process.env.BAHULAM_HOME = temp;
const binding = { bahulam_organization_id: 'customer', teams_tenant_id: 'tenant',
  teams_team_id: 'ms-team', teams_channel_id: 'channel', personal: true,
  organization: 'contoso', project: 'Product', team: 'Product Team', users: { alice: { pat_env: 'ADO_ALICE' }, bob: { pat_env: 'ADO_BOB' } } };
const activity = (id, text = 'my tasks', actor = 'alice') => ({ id, text, type: 'message', channelId: 'msteams',
  from: { aadObjectId: actor }, conversation: { id: 'personal-chat', conversationType: 'personal' }, channelData: { tenant: { id: 'tenant' } } });
const tables = [{ name: 'teams_receipts', columns: [
  { name: 'id', type: 'TEXT', primary: true }, { name: 'status', type: 'TEXT' }, { name: 'created_at', type: 'TEXT' },
] }];
const openState = scope => makePluginState(`teams-test-${scope.slice(0, 48)}`, { tables });
try {
  const resolved = resolveBinding(activity('a'), [binding]);
  assert.notEqual(resolved.scope, resolveBinding(activity('a', 'x', 'bob'), [binding]).scope);
  assert.throws(() => resolveBinding(activity('a', 'x', 'mallory'), [binding]));
  assert.throws(() => resolveBinding({ ...activity('a'), channelData: { tenant: { id: 'other' } } }, [binding]));
  assert.throws(() => resolveBinding(activity('a'), [binding, binding]));
  const channel = { ...activity('a'), conversation: { id: 'thread', conversationType: 'channel' },
    channelData: { tenant: { id: 'tenant' }, team: { id: 'ms-team' }, channel: { id: 'channel' } } };
  assert.equal(resolveBinding(channel, [binding]).binding.project, 'Product');
  assert.throws(() => resolveBinding({ ...channel, channelData: { ...channel.channelData, channel: { id: 'other' } } }, [binding]));
  assert.equal(scopedState({}, resolved).getConfig('personal_access_token'), null);

  const requests = [];
  const connection = createAzureDevOpsConnection({ organization: 'contoso', project: 'Product', team: 'Product Team', pat: 'test-secret',
    fetchImpl: async (url, opts) => { requests.push({ url, opts }); return new Response(JSON.stringify({ id: 42 })); } });
  assert.equal('pat' in connection, false);
  assert.equal('pat' in connection.config, false);
  await connection.request({ path: 'Product/_apis/wit/workitems/42' });
  assert.match(requests[0].opts.headers.Authorization, /^Basic /);
  assert.equal(requests[0].opts.redirect, 'error');
  for (const evil of ['https://evil.test', '../Other/_apis/wit/workitems/42', 'Other/_apis/wit/workitems/42',
    'Product/_apis/../../Other', 'Product/_apis/%2e%2e/Other', 'Product/_apis/a%2fb', '_apis/projects']) {
    await assert.rejects(() => connection.request({ path: evil }));
  }
  await assert.rejects(() => connection.request({ method: 'PATCH', path: 'Product/_apis/wit/workitems/42', body: [{ path: '/fields/System.TeamProject', value: 'Other' }] }));
  assert.equal(requests.length, 1);

  let runs = 0;
  let writes = 0;
  let lastHistory;
  const messages = [];
  const tools = new Map([['change', { approvalArgument: 'approved', call: async args => {
    if (!args.approved) return { success: false, output: { needs_approval: true } };
    writes++;
    return { success: true, output: { changed: args.value } };
  } }]]);
  const runAgent = async ({ text, history, execute }) => {
    runs++;
    lastHistory = history;
    if (text === 'propose') return JSON.stringify(await execute('change', { requires_approval: true, value: 'Closed' }));
    if (text === 'self-approve') return JSON.stringify(await execute('change', { approved: true, value: 'Closed' }));
    return 'Your tasks';
  };
  const makeHandler = () => createTeamsHandler({ loadBindings: async () => [binding], openState, runAgent, tools, resolveConnection: async () => connection });
  let handler = makeHandler();
  const send = async text => messages.push(text);
  await Promise.all([handler({ activity: activity('one'), send }), handler({ activity: activity('one'), send })]);
  assert.equal(runs, 1, 'duplicate activity runs only once');
  handler = makeHandler();
  await handler({ activity: activity('one'), send });
  assert.equal(runs, 1, 'receipt survives restart');
  await handler({ activity: activity('two'), send });
  assert.equal(lastHistory.length, 2, 'history survives restart');
  await handler({ activity: activity('three', 'my tasks', 'bob'), send });
  assert.equal(lastHistory.length, 0, 'history is isolated by caller');
  await handler({ activity: activity('four', 'self-approve'), send });
  assert.equal(writes, 0);
  assert.match(messages.at(-1), /user’s \/approve/);
  await handler({ activity: activity('five', 'propose'), send });
  const command = JSON.parse(messages.at(-1)).output.approval_command;
  await handler({ activity: activity('six', command, 'bob'), send });
  assert.equal(writes, 0, 'another caller cannot approve');
  await handler({ activity: activity('seven', command), send });
  assert.equal(writes, 1);
  await handler({ activity: activity('eight', command), send });
  assert.equal(writes, 1, 'approval is consumed exactly once');
  const beforeUnknown = runs;
  await handler({ activity: activity('nine', 'x', 'mallory'), send });
  assert.equal(runs, beforeUnknown, 'unmapped caller never invokes model');

  // Exercise the actual graph dispatcher, manifest loader, tool schema and
  // allowlist without contacting a model service. Session substrate is injected.
  const fixture = path.join(temp, 'plugin');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'plugin.yaml'), `apiVersion: bahulam.plugin/1
kind: Plugin
metadata: { name: connector-fixture, version: 1.0.0 }
config:
  workspace: ./agent.yaml
  tools:
    - name: echo
      description: Echo input
      tool: ./echo.mjs
      parameters: { type: object, properties: { text: { type: string } } }
`);
  fs.writeFileSync(path.join(fixture, 'agent.yaml'), `apiVersion: agent.framework/v1
kind: SingleAgent
metadata: { slug: fixture, name: Fixture }
agent: { system_prompt: Use echo. }
tools: [echo]
`);
  fs.writeFileSync(path.join(fixture, 'echo.mjs'), 'export async function call(args) { return { success: true, output: args.text }; }');
  const runtime = await loadRuntime({ pluginDir: fixture, dispatchOverride: (event, ctx) => dispatch({ ...event, substrate: 'session' }, {
    ...ctx, sessionSubstrate: async function* (agent, node, instruction, { scopedExecutor }) {
      assert.equal(ctx.toolExecutor.listPluginToolSchemas()[0].name, 'echo');
      assert.equal((await scopedExecutor.execute('run_command', {})).success, false);
      const result = await scopedExecutor.execute('echo', { text: 'connected' });
      yield { type: 'complete', data: { final_response: result.output } };
    },
  }) });
  assert.equal(await runtime.runAgent({ text: 'hello', history: [], execute: (name, args) => runtime.tools.get(name).call(args), sessionId: 'test' }), 'connected');
  const persisted = runtime.openState('test');
  persisted.query('INSERT INTO teams_receipts (id, status, created_at) VALUES (?, ?, ?)', ['x', 'completed', 'today']);
  assert.equal(persisted.query('SELECT status FROM teams_receipts')[0].status, 'completed');
  persisted.close();
  console.log('Teams infrastructure tests passed: identity mapping, isolation, connection scope, duplicate delivery, approvals, persistence and Bahulam graph execution.');
} finally {
  if (previousHome === undefined) delete process.env.BAHULAM_HOME;
  else process.env.BAHULAM_HOME = previousHome;
  fs.rmSync(temp, { recursive: true, force: true });
}
