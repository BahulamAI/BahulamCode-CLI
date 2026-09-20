import assert from 'node:assert/strict';
import { term, _setForTesting } from '../src/ui/term.mjs';
import { paint, strip } from '../src/ui/palette.mjs';
import { cellWidth } from '../src/ui/render-queue.mjs';
import { blockSeparatorMode, transcriptBoundary } from '../src/ui/transcript-block.mjs';
import { codeRuns } from '../src/ui/code-syntax.mjs';
import { renderMarkdown } from '../src/terminal/ansi.mjs';
import { EventFormatter } from '../src/ui/formatter.mjs';
import { captureTranscript } from './fixtures/transcript-sections.mjs';

const original = { ...term() };
const previousMode = process.env.BAHULAM_BLOCK_SEPARATOR;
let checks = 0;
try {
  delete process.env.BAHULAM_BLOCK_SEPARATOR;
  assert.equal(blockSeparatorMode(), 'subtle');
  for (const appearance of ['light', 'dark']) for (const columns of [24, 40, 80, 120]) {
    _setForTesting({ columns, appearance, color: true, colorLevel: 'truecolor', unicode: true });
    for (const [prev, next] of [['user', 'content'], ['content', 'tool'], ['tool', 'content'], ['content', 'user']]) {
      const boundary = transcriptBoundary(prev, next);
      assert.match(strip(boundary), /─/);
      assert.ok(boundary.split('\n').every(row => cellWidth(row) < columns));
      checks++;
    }
    assert.equal(transcriptBoundary(null, 'content'), '');
    assert.equal(transcriptBoundary('content', 'content', { compactSame: true }), '');
    assert.equal(transcriptBoundary('tool', 'tool', { compactSame: true }), '');
    assert.equal(transcriptBoundary('tool', 'subagent'), '\n');
    assert.equal(transcriptBoundary('tool', 'status'), '\n');
    assert.equal(transcriptBoundary('user', 'content', { mode: 'space' }), '\n');
    assert.equal(transcriptBoundary('user', 'content', { mode: 'off' }), '');
    const code = renderMarkdown('```typescript\nconst message = "' + '語'.repeat(25) + '";\nconst retries = 3;\n```');
    assert.ok(code.includes(paint.token('syntax.keyword').open));
    assert.ok(code.includes(paint.token('syntax.string').open));
    assert.ok(code.includes(paint.token('syntax.literal').open));
    assert.ok(!code.includes(paint.token('state.success').open), 'code is not colored as success');
    assert.ok(code.split('\n').every(row => cellWidth('  ' + row) < columns), 'code fences and wrapped lines leave room for transcript indent');
  }
  for (const [language, input] of [
    ['typescript', 'const url = "https://example.test"; // comment'],
    ['python', 'return "#not a comment" # comment'],
    ['json', '{"retries": 3, "enabled": true, "message": "ready"}'],
    ['yaml', 'timeout: 3 # seconds'],
    ['bash', 'echo "ready" # comment'],
    ['unknown', 'literal text: 語\t[]'],
  ]) assert.equal(codeRuns(input, language).map(run => run.text).join(''), input);
  for (const mode of ['subtle', 'space', 'off']) {
    const transcript = strip(captureTranscript({ mode }));
    assert.equal((transcript.match(/bahulam ›/g) || []).length, 3, 'label repeats after tools and on a new turn, not per chunk');
    assert.equal((transcript.match(/you ›/g) || []).length, 2);
    assert.equal((transcript.match(/^  ─+$/gm) || []).length, mode === 'subtle' ? 5 : 0);
    for (const text of ['existing guard', 'focused checks', '12 checks passed', 'retries', 'Authorization now checks scope']) assert.ok(transcript.includes(text));
  }
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let formatted = '';
  try {
    process.stdout.write = process.stderr.write = chunk => { formatted += String(chunk); return true; };
    const formatter = new EventFormatter();
    formatter.render({ type: 'content_partial', data: { text: 'First chunk.' } });
    formatter.render({ type: 'content_partial', data: { text: 'Second chunk.' } });
    formatter.render({ type: 'tool_call', data: { tool: 'read_file', call_id: 'read', args: { file_path: 'src/auth.ts' } } });
    formatter.render({ type: 'tool_done', data: { tool: 'read_file', call_id: 'read', success: true } });
    formatter.render({ type: 'content', data: { text: 'Reply after tools.' } });
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  assert.equal((strip(formatted).match(/Bahulam ›/g) || []).length, 2);
  assert.equal((strip(formatted).match(/^  ─+$/gm) || []).length, 2);
  _setForTesting({ color: false, colorLevel: 'none', unicode: false, plain: true });
  const plain = transcriptBoundary('tool', 'content') + renderMarkdown('```json\n{"retries": 3}\n```');
  assert.ok(!plain.includes('\x1b'));
  assert.match(plain, /^[\x00-\x7f]*$/);
  assert.match(transcriptBoundary('tool', 'content', { mode: 'dotted' }), /\.\.\./);
  console.log(checks + ' transcript boundary cases plus streaming, tools, color roles, narrow code, and plain-mode regressions passed.');
} finally {
  _setForTesting(original);
  if (previousMode === undefined) delete process.env.BAHULAM_BLOCK_SEPARATOR;
  else process.env.BAHULAM_BLOCK_SEPARATOR = previousMode;
}
