import assert from 'node:assert/strict';
import { normalizeUsage } from '../src/core/usage-normalization.mjs';

assert.deepEqual(normalizeUsage({
  prompt_tokens: 120,
  completion_tokens: 30,
  prompt_tokens_details: { cached_tokens: 80 },
}), {
  input_tokens: 120,
  output_tokens: 30,
  cache_read_input_tokens: 80,
  cache_creation_input_tokens: 0,
});

assert.deepEqual(normalizeUsage({
  total_input_tokens: 220,
  total_output_tokens: 40,
  cache_read_tokens: 150,
  cache_creation_tokens: 20,
}), {
  input_tokens: 220,
  output_tokens: 40,
  cache_read_input_tokens: 150,
  cache_creation_input_tokens: 20,
});

assert.deepEqual(normalizeUsage({ input_tokens: 7, output_tokens: 3 }), {
  input_tokens: 7,
  output_tokens: 3,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

console.log('3 usage-normalization tests passed');
