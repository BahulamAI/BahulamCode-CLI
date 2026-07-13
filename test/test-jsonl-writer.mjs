/**
 * Regression tests for JSONL writer tool-result handling.
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-jsonl-writer-'));

const { JsonlWriter } = await import('../src/core/jsonl-writer.mjs');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    })
    .catch((err) => {
      console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
      failed++;
    });
}

console.log('\n\x1b[1mtest-jsonl-writer.mjs\x1b[0m\n');

await test('flushAssistantTurn tolerates undefined tool output', async () => {
  const cwd = path.join(tempRoot, 'project');
  const outputDir = path.join(tempRoot, 'jsonl-output');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const writer = new JsonlWriter(cwd, 'test');
  writer.projectDir = outputDir;
  writer.setSessionId('session-1');
  writer.writeUserTurn('debug this');
  writer.accumulateContent('done');
  writer.accumulateToolCall('call-1', 'git_status', {});
  writer.recordToolResult('call-1', undefined, false);
  writer.flushAssistantTurn();
  await writer.close();

  const transcriptPath = path.join(writer.projectDir, 'session-1.jsonl');
  const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.strictEqual(lines.length, 3);
  const toolResultEntry = lines[2];
  assert.strictEqual(toolResultEntry.message.role, 'user');
  assert.strictEqual(toolResultEntry.message.content[0].type, 'tool_result');
  assert.strictEqual(toolResultEntry.message.content[0].content, '');

  fs.rmSync(writer.projectDir, { recursive: true, force: true });
});

await test('writeKeplerEvent buffers until real session id is set', async () => {
  const cwd = path.join(tempRoot, 'event-project');
  const outputDir = path.join(tempRoot, 'event-output');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const writer = new JsonlWriter(cwd, 'test');
  writer.projectDir = outputDir;
  writer.writeKeplerEvent({ type: 'status', data: { message: 'Starting' } });
  writer.setSessionId('event-session-1');
  writer.writeKeplerEvent({ type: 'tool_call', data: { tool: 'read_file', args: { path: 'a'.repeat(12000) } } });
  await writer.close();

  const transcriptPath = path.join(writer.projectDir, 'event-session-1.jsonl');
  const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].type, 'kepler_event');
  assert.strictEqual(lines[0].sessionId, 'event-session-1');
  assert.strictEqual(lines[0].event.type, 'status');
  assert.strictEqual(lines[1].event.type, 'tool_call');
  assert.ok(lines[1].event.data.args.path.includes('[...truncated...]'));

  fs.rmSync(writer.projectDir, { recursive: true, force: true });
});

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
