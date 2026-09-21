import assert from 'node:assert';
import {
  ToolError,
  toolError,
  normalizeToolResult,
  formatErrorSummary,
  buildNextTurnHint,
} from '../src/core/tool-error.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

console.log('\n\x1b[1mtest-tool-error.mjs\x1b[0m\n');

test('toolError helper builds a valid envelope', () => {
  const err = toolError('MISSING_RESOURCE', 'Scene "cafe" not found.', 'Call create_scene(name="cafe") first.');
  assert.strictEqual(err.success, false);
  assert.strictEqual(err.error.code, 'MISSING_RESOURCE');
  assert.strictEqual(err.error.message, 'Scene "cafe" not found.');
  assert.strictEqual(err.error.hint, 'Call create_scene(name="cafe") first.');
  assert.strictEqual(err.output, 'Scene "cafe" not found.');
});

test('ToolError class exposes code + hint', () => {
  const e = new ToolError('INVALID_ARGS', 'position must be [x,y,z]', 'Use a length-3 array.');
  assert.strictEqual(e.code, 'INVALID_ARGS');
  assert.strictEqual(e.message, 'position must be [x,y,z]');
  assert.strictEqual(e.hint, 'Use a length-3 array.');
  assert.ok(e instanceof Error);
  assert.ok(e instanceof ToolError);
});

test('normalizeToolResult wraps success values with meta', () => {
  const r = normalizeToolResult({ tool: 't', plugin: 'p' }, { success: true, output: { count: 3 } });
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.output, { count: 3 });
  assert.strictEqual(r._tool, 't');
  assert.strictEqual(r._plugin, 'p');
});

test('normalizeToolResult passes plain (non-object) returns through as success', () => {
  const r = normalizeToolResult({ tool: 't' }, 'hello');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.output, 'hello');
});

test('normalizeToolResult extracts structured error envelope', () => {
  const r = normalizeToolResult({ tool: 't' }, toolError('MISSING_RESOURCE', 'Node "chair_99" not found.', 'Call get_scene first.'));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'MISSING_RESOURCE');
  assert.strictEqual(r.error.hint, 'Call get_scene first.');
  // output is self-contained: includes [code] + message + hint
  assert.ok(r.output.startsWith('[MISSING_RESOURCE]'));
  assert.ok(r.output.includes('hint: Call get_scene first.'));
});

test('normalizeToolResult synthesizes UNKNOWN for legacy { success:false, output }', () => {
  const r = normalizeToolResult({ tool: 't' }, { success: false, output: 'legacy message' });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'UNKNOWN');
  assert.ok(r.output.startsWith('[UNKNOWN]'));
  assert.ok(r.output.includes('legacy message'));
});

test('normalizeToolResult handles thrown ToolError', () => {
  const thrown = new ToolError('IO', 'Could not write file.', 'Check permissions on ~/.bahulam/data/');
  const r = normalizeToolResult({ tool: 't' }, null, thrown);
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'IO');
  assert.strictEqual(r.error.hint, 'Check permissions on ~/.bahulam/data/');
  assert.ok(r.output.includes('[IO]'));
  assert.ok(r.output.includes('hint: Check permissions'));
});

test('normalizeToolResult handles thrown plain Error as UNKNOWN', () => {
  const r = normalizeToolResult({ tool: 't' }, null, new Error('boom'));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'UNKNOWN');
  assert.strictEqual(r.error.message, 'boom');
  assert.ok(r.output.startsWith('[UNKNOWN]'));
});

test('normalizeToolResult does not double-prefix output that already has [code]', () => {
  const withEnvelope = { success: false, output: '[MISSING_RESOURCE] Section "x" not found.', error: { code: 'MISSING_RESOURCE', message: 'Section "x" not found.' } };
  const r = normalizeToolResult({ tool: 't' }, withEnvelope);
  assert.strictEqual(r.output.match(/\[MISSING_RESOURCE\]/g).length, 1);
});

test('normalizeToolResult attaches trace id when supplied', () => {
  const r = normalizeToolResult({ tool: 't', traceId: 'trace_abc' }, { success: true, output: 1 });
  assert.strictEqual(r._trace_id, 'trace_abc');
});

test('formatErrorSummary produces one-line log format', () => {
  const s = formatErrorSummary({ code: 'IO', message: 'multi\nline\nmessage', hint: 'do the thing' });
  assert.ok(s.includes('[IO]'));
  assert.ok(!s.includes('\n'), 'expected newlines to be collapsed');
  assert.ok(s.includes('hint: do the thing'));
});

test('buildNextTurnHint produces LLM-friendly hint', () => {
  const hint = buildNextTurnHint({ tool: 'create_node', error: { code: 'MISSING_RESOURCE', message: 'Node not found.', hint: 'Call get_scene first.' } });
  assert.ok(hint.includes('`create_node`'));
  assert.ok(hint.includes('[MISSING_RESOURCE]'));
  assert.ok(hint.includes('Hint:'));
});

test('buildNextTurnHint returns empty string when no error', () => {
  assert.strictEqual(buildNextTurnHint({ tool: 't', error: null }), '');
});

console.log(`\n  \x1b[32m${passed} passed\x1b[0m\n`);
