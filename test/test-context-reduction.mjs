import assert from 'node:assert/strict';
import {
  collapseMessages,
  contextPolicy,
  resolveContextBudget,
} from '../src/core/context-reduction.mjs';
import {
  cacheableSystem,
  cacheableTools,
  withMessageBreakpoint,
} from '../src/core/cache-control.mjs';

const messages = [
  { role: 'user', content: 'root request' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { file_path: 'a.js' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] },
  { role: 'assistant', content: 'continuing' },
  { role: 'user', content: 'latest request' },
];

const collapsed = collapseMessages(messages, '[Context summary]', 3);
assert.equal(collapsed[0].content, '[Context summary]');
assert.equal(collapsed[1].role, 'assistant');
assert.ok(collapsed.some(message => message.content?.[0]?.type === 'tool_use'));
assert.ok(collapsed.some(message => message.content?.[0]?.type === 'tool_result'));

const budget = resolveContextBudget({
  product: 'ide',
  contextLength: 128_000,
  maxOutput: 8_000,
  fixedPromptTokens: 12_000,
});
assert.equal(budget.source, 'model_catalog');
assert.ok(budget.threshold > 0 && budget.threshold < 128_000);
assert.equal(contextPolicy('workspace').preserve, 14);

const system = cacheableSystem('stable system prompt');
const tools = cacheableTools([{ type: 'function', function: { name: 'read_file' } }]);
const marked = withMessageBreakpoint([
  { role: 'user', content: 'older' },
  { role: 'assistant', content: 'answer' },
  { role: 'user', content: 'latest' },
]);
assert.equal(system[0].cache_control.ttl, '1h');
assert.equal(tools[0].cache_control.ttl, '1h');
assert.ok(Array.isArray(marked[0].content));
assert.equal(marked[0].content[0].cache_control.type, 'ephemeral');

console.log('test-context-reduction.mjs: passed');
