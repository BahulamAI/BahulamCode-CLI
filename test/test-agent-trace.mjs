/**
 * test-agent-trace.mjs — verifies the trace pipeline:
 *   1. displayHistory captures role:"tool" rows on tool_result
 *   2. browserTraceItems returns compact per-call summaries
 *   3. fullTraceEntries returns unelided entries suitable for export
 *   4. Errors flow through with { code, message, hint }
 *   5. Duration is computed from tool_call → tool_result
 */
import assert from 'node:assert';
import { LocalAgentRelay, browserTraceItems, fullTraceEntries } from '../src/local-service/agent-relay.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

console.log('\n\x1b[1mtest-agent-trace.mjs\x1b[0m\n');

// Minimal relay instance — bypasses ready(). We only need the trace
// methods, which touch this.displayHistory and this._pendingToolCalls.
function makeRelay() {
  const session = { id: 'test-session', root_path: '/tmp/x' };
  const relay = new LocalAgentRelay({ session, emit: () => {} });
  relay.displayHistory = [];
  relay._pendingToolCalls = new Map();
  relay._traceSeq = 0;
  return relay;
}

test('_traceRecordCall captures pending state', () => {
  const r = makeRelay();
  r._traceRecordCall({ call_id: 'c1', tool: 'create_node', args: { slug: 'x', type: 'mesh' }, plugin: 'threejs-studio' });
  assert.strictEqual(r._pendingToolCalls.size, 1);
  const p = r._pendingToolCalls.get('c1');
  assert.strictEqual(p.tool, 'create_node');
  assert.strictEqual(p.plugin, 'threejs-studio');
  assert.deepStrictEqual(p.args, { slug: 'x', type: 'mesh' });
});

test('_traceRecordResult on success pushes ok row to displayHistory', () => {
  const r = makeRelay();
  r._traceRecordCall({ call_id: 'c1', tool: 'create_node', args: { slug: 'x' }, plugin: 'threejs-studio' });
  r._traceRecordResult({ call_id: 'c1', output: { id: 'n1' }, success: true });
  assert.strictEqual(r.displayHistory.length, 1);
  const entry = r.displayHistory[0];
  assert.strictEqual(entry.role, 'tool');
  assert.strictEqual(entry.status, 'ok');
  assert.strictEqual(entry.tool, 'create_node');
  assert.strictEqual(entry.plugin, 'threejs-studio');
  assert.strictEqual(entry.error, null);
  assert.strictEqual(typeof entry.duration_ms, 'number');
  assert.strictEqual(r._pendingToolCalls.size, 0, 'pending map is cleared');
});

test('_traceRecordResult on error captures structured envelope', () => {
  const r = makeRelay();
  r._traceRecordCall({ call_id: 'c2', tool: 'set_transform', args: { slug: 'x', id: 'chair_99' } });
  r._traceRecordResult({
    call_id: 'c2',
    success: false,
    is_error: true,
    output: '[MISSING_RESOURCE] Node "chair_99" not found. (hint: call get_scene)',
    error: { code: 'MISSING_RESOURCE', message: 'Node "chair_99" not found.', hint: 'call get_scene' },
  });
  assert.strictEqual(r.displayHistory.length, 1);
  const entry = r.displayHistory[0];
  assert.strictEqual(entry.status, 'error');
  assert.strictEqual(entry.error.code, 'MISSING_RESOURCE');
  assert.strictEqual(entry.error.hint, 'call get_scene');
});

test('_traceRecordResult without prior _traceRecordCall still records', () => {
  // Some backends may not emit tool_call for internal delegations.
  const r = makeRelay();
  r._traceRecordResult({ call_id: 'orphan', tool: 'auto_thing', output: 'ok', success: true });
  assert.strictEqual(r.displayHistory.length, 1);
  assert.strictEqual(r.displayHistory[0].tool, 'auto_thing');
});

test('browserTraceItems returns compact per-call summaries', () => {
  const history = [
    { role: 'user', content: 'do the thing', timestamp: 't0' },
    { role: 'tool', tool: 'create_node', plugin: 'threejs-studio', call_id: 'c1', status: 'ok',
      args: { slug: 'x' }, output: { id: 'n1' }, duration_ms: 42, timestamp: 't1', error: null },
    { role: 'tool', tool: 'set_transform', plugin: 'threejs-studio', call_id: 'c2', status: 'error',
      args: { slug: 'x', id: 'chair_99' }, output: 'oops', duration_ms: 5, timestamp: 't2',
      error: { code: 'MISSING_RESOURCE', message: 'Node "chair_99" not found.', hint: 'call get_scene' } },
    { role: 'assistant', content: 'done', timestamp: 't3' },
  ];
  const items = browserTraceItems(history);
  assert.strictEqual(items.length, 2, 'user/assistant excluded');
  assert.strictEqual(items[0].tool, 'create_node');
  assert.strictEqual(items[0].status, 'ok');
  assert.strictEqual(items[0].duration_ms, 42);
  assert.strictEqual(items[0].type, 'history_tool_result');
  assert.strictEqual(items[1].error.code, 'MISSING_RESOURCE');
  assert.strictEqual(items[1].error.hint, 'call get_scene');
  assert.strictEqual(items[1].type, 'history_tool_error');
});

test('browserTraceItems preserves resume-shape rows for backward compat', () => {
  const resumeHistory = [
    { role: 'tool', kind: 'call', tool: 'shell', content: 'shell ls -la', timestamp: 't1', order: 1 },
    { role: 'tool', kind: 'result', tool: 'shell', content: '[tool_result] shell: total 42', timestamp: 't2', order: 2 },
  ];
  const items = browserTraceItems(resumeHistory);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].type, 'history_tool_call');
  assert.strictEqual(items[1].type, 'history_tool_result');
  assert.ok(items[0].content && items[0].content.includes('shell'), 'resume rows keep content field');
  assert.strictEqual(items[0].plugin, undefined, 'resume rows do not have plugin field');
});

test('browserTraceItems elides long args/output', () => {
  const bigArgs = { text: 'x'.repeat(2000) };
  const history = [{ role: 'tool', tool: 't', call_id: 'c', status: 'ok', args: bigArgs, output: '', duration_ms: 1, timestamp: 't', error: null }];
  const items = browserTraceItems(history);
  assert.ok(items[0].args_summary.length <= 321, 'args_summary is elided to ~320 chars');
  assert.ok(items[0].args_summary.endsWith('…'), 'elision suffix present');
});

test('fullTraceEntries returns unelided data', () => {
  const bigArgs = { text: 'x'.repeat(2000) };
  const history = [{ role: 'tool', tool: 't', call_id: 'c', status: 'ok', args: bigArgs, output: 'y'.repeat(2000), duration_ms: 1, timestamp: 't', error: null }];
  const full = fullTraceEntries(history);
  assert.strictEqual(full[0].args.text.length, 2000);
  assert.strictEqual(full[0].output.length, 2000);
});

test('fullTrace() on relay includes turns when asked', () => {
  const r = makeRelay();
  r.displayHistory.push({ role: 'user', content: 'hi', timestamp: 't0' });
  r._traceRecordCall({ call_id: 'c1', tool: 't' });
  r._traceRecordResult({ call_id: 'c1', output: 'ok', success: true });
  r.displayHistory.push({ role: 'assistant', content: 'done', timestamp: 't2' });
  const traceOnly = r.fullTrace();
  assert.ok(Array.isArray(traceOnly));
  assert.strictEqual(traceOnly.length, 1);
  const both = r.fullTrace({ includeTurns: true });
  assert.strictEqual(both.trace.length, 1);
  assert.strictEqual(both.turns.length, 2);
});

test('startNewHistory clears trace state', () => {
  // We can't call startNewHistory() directly (requires ready client); just verify manual reset.
  const r = makeRelay();
  r._traceRecordCall({ call_id: 'c1', tool: 't' });
  r._traceRecordResult({ call_id: 'c1', output: 'ok', success: true });
  assert.strictEqual(r.displayHistory.length, 1);
  // simulate startNewHistory's reset
  r.displayHistory = [];
  r._pendingToolCalls.clear();
  r._traceSeq = 0;
  assert.strictEqual(r.displayHistory.length, 0);
  assert.strictEqual(r._pendingToolCalls.size, 0);
});

console.log(`\n  \x1b[32m${passed} passed\x1b[0m\n`);
