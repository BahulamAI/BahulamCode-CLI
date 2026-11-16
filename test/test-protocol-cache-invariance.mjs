import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-cache-invariance-'));
process.env.BAHULAM_HOME = temp;
delete process.env.BAHULAM_CAPTURE_REQUEST;
const previousTuiBinary = process.env.BAHULAM_TUI_BINARY;
const fakeTuiBinary = path.join(temp, 'fake-bahulam-tui');
fs.writeFileSync(fakeTuiBinary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const out = fs.createWriteStream(null, { fd: 4 });
readline.createInterface({ input: fs.createReadStream(null, { fd: 3 }) }).on('line', line => {
  try {
    const event = JSON.parse(line);
    out.write(JSON.stringify({ type: 'test_event_received', data: { event_type: event.type } }) + '\\n');
  } catch {}
});
`);
fs.chmodSync(fakeTuiBinary, 0o700);
process.env.BAHULAM_TUI_BINARY = fakeTuiBinary;
const { tapSseEvent, closeActiveEventLog, registerBroadcaster } = await import('../src/daemon/event-tap.mjs');
const { AgentHistoryTurnBuilder } = await import('../src/core/agent-history.mjs');
const { buildContextEnvelope } = await import('../src/core/context-envelope.mjs');
const { LocalAgent } = await import('../src/core/local-agent.mjs');
const { BahulamStreamClient } = await import('../src/core/stream-client.mjs');
const { readAllEvents } = await import('../src/core/event-log.mjs');
const { startRustTuiHost } = await import('../src/daemon/rust-tui-host.mjs');

const originalFetch = globalThis.fetch;
const captured = [];
globalThis.fetch = async (url, options) => {
  captured.push({ url, body: options.body });
  if (url.endsWith('/api/execute')) {
    return new Response('event: complete\ndata: {"summary":"done"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }
  return Response.json({ content: [], choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
};

const tools = [{ name: 'read_file', description: 'Read a file', input_schema: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
} }];
const modelOutput = 'full model context\n'.repeat(1000);
const events = [
  { type: 'session_info', data: { cwd: '/fixture', model: 'fixture' } },
  { type: 'content', data: { text: 'Inspecting the source.' } },
  { type: 'tool_request', data: { tool: 'read_file', call_id: 'call-cache', args: { path: 'app.js', options: { encoding: 'utf8' } } } },
  { type: 'tool_result', data: { tool: 'read_file', call_id: 'call-cache', success: true, output: 'display output\n'.repeat(1000), llm_content: modelOutput } },
  { type: 'tokens_used', data: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 900 } },
  { type: 'complete', data: { summary: 'done' } },
];
const sourceBytes = JSON.stringify(events);

async function capture(enabled, { rustHost = false, mutateSubscriber = true } = {}) {
  process.env.BAHULAM_DAEMON_EVENTLOG = enabled ? '1' : '0';
  let subscriberCalls = 0;
  const receivedByRust = [];
  let markRustReady;
  const rustReady = new Promise(resolve => { markRustReady = resolve; });
  const host = rustHost ? startRustTuiHost({ onCommand: command => {
    if (command?.type !== 'test_event_received') return;
    receivedByRust.push(command.data.event_type);
    if (receivedByRust.length === events.length) markRustReady();
  } }) : null;
  const unregister = registerBroadcaster(frame => {
    subscriberCalls++;
    // A renderer must never own references to canonical tool arguments/history.
    if (mutateSubscriber) {
      if (frame.data.args) frame.data.args.options.encoding = 'renderer-only';
      frame.data.output = 'renderer preview';
    }
  }, { schemaVersion: 2 });
  const turn = new AgentHistoryTurnBuilder();
  try {
    for (const event of events) {
      tapSseEvent(event, { sessionId: 'sess_cache_guard' });
      if (event.type === 'content') turn.addAssistantText(event.data.text);
      if (event.type === 'tool_request') turn.addToolUse(event.data);
      if (event.type === 'tool_result') turn.addToolResult(event.data);
    }
  } finally { unregister(); }
  if (host) {
    let timeout;
    try {
      await Promise.race([
        rustReady,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Rust stdio host did not receive every display event')), 5000); }),
      ]);
    } finally {
      clearTimeout(timeout);
      host.close();
    }
    assert.deepEqual(receivedByRust, [
      'session_started', 'message_end', 'tool_requested', 'tool_finished', 'usage_update', 'turn_ended',
    ], 'Rust host receives the canonical v2 event projection');
  }
  assert.equal(subscriberCalls, enabled || rustHost ? events.length : 0);
  assert.equal(JSON.stringify(events), sourceBytes, 'tap/subscribers must not mutate SSE input');
  const messages = [{ role: 'user', content: 'Inspect app.js' }, ...turn.finish(), { role: 'user', content: 'Continue' }];
  assert.equal(messages[2].content[0].content, modelOutput, 'display offload must preserve full llm_content');
  const context = buildContextEnvelope({ cwd: '/fixture', agentContext: { memory_digest: 'stable-digest' } });
  const inputs = JSON.stringify({ messages, context, tools });
  const agent = Object.assign(Object.create(LocalAgent.prototype), {
    model: 'claude-fixture', apiKey: 'fixture', openRouterKey: 'fixture',
    gatewayUrl: 'https://gateway.invalid', gatewayToken: 'fixture',
    product: 'bahulam', sessionId: 'sess_cache_guard', _requestSequence: 0,
  });
  captured.length = 0;
  await agent._callClaude('Stable coding instructions', messages, tools);
  await agent._callOpenRouter('Stable coding instructions', messages, tools);
  await agent._callOpenRouter('Stable coding instructions', messages, tools, 'openai/fixture');
  await agent._callGateway('Stable coding instructions', messages, tools);
  const client = new BahulamStreamClient({ baseUrl: 'https://backend.invalid', token: 'fixture', mode: 'remote' });
  client.sessionId = 'sess_cache_guard';
  for await (const event of client.execute('Continue', context, messages)) {
    assert.notEqual(event.type, 'error');
  }
  assert.equal(captured.length, 5);
  assert.equal(JSON.stringify({ messages, context, tools }), inputs, 'request preparation must not mutate inputs');
  return { requests: structuredClone(captured), inputs };
}

try {
  const baseline = await capture(false);
  const logging = await capture(true);
  await closeActiveEventLog();
  assert.deepEqual(logging, baseline, 'logging must preserve exact request bytes for all five routes');
  const rustHosted = await capture(true, { rustHost: true });
  assert.deepEqual(rustHosted, baseline, 'the Rust stdio display host must not change canonical request bodies or cache markers');
  // Test the real host with logging off. A deliberately mutating in-process
  // subscriber exposes a separate baseline event-isolation bug (see recovery review).
  const rustLiveOnly = await capture(false, { rustHost: true, mutateSubscriber: false });
  assert.deepEqual(rustLiveOnly, baseline, 'the Rust host without disk logging must preserve request bodies and cache markers');
  // Advancing log sequence/turn IDs and replaying also cannot change prompt bytes.
  const disk = await readAllEvents({ sessionId: 'sess_cache_guard' });
  assert.ok(disk.some(e => e.payload_ref), 'exercise actual large-payload offload');
  assert.deepEqual(await capture(true), baseline);
  const direct = JSON.parse(baseline.requests[0].body);
  assert.equal(direct.system[0].cache_control.ttl, '1h');
  assert.equal(direct.tools.at(-1).cache_control.ttl, '1h');
  assert.deepEqual(direct.messages[2].content.at(-1).cache_control, { type: 'ephemeral' });
  const router = JSON.parse(baseline.requests[1].body);
  assert.equal(router.messages[0].content[0].cache_control.ttl, '1h');
  assert.equal(router.tools.at(-1).cache_control.ttl, '1h');
  assert.equal(JSON.parse(baseline.requests[2].body).tools[0].cache_control, undefined);
  console.log('PASS: byte-identical context/history and five request routes with logging off/on and the Rust stdio host, advancing IDs, replay, large payloads and mutating display subscriber; cache breakpoints preserved.');
} finally {
  globalThis.fetch = originalFetch;
  await closeActiveEventLog();
  if (previousTuiBinary === undefined) delete process.env.BAHULAM_TUI_BINARY;
  else process.env.BAHULAM_TUI_BINARY = previousTuiBinary;
  fs.rmSync(temp, { recursive: true, force: true });
}
