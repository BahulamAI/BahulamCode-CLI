import assert from 'node:assert/strict';
import { term, _setForTesting } from '../src/ui/term.mjs';
import { paint, strip } from '../src/ui/palette.mjs';
import { cellWidth } from '../src/ui/render-queue.mjs';
import { wrapCode } from '../src/ui/code-layout.mjs';
import { renderUnifiedDiff, renderFileDiffs, parseUnifiedDiff, changedWords } from '../src/ui/diff.mjs';
import { commandRuns, commandStatus, renderCommandResult, toolSource, workspaceAction } from '../src/ui/command-card.mjs';
import { buildFileDiff } from '../src/core/file-diff.mjs';
import { formatCard, formatCardHead, recordCard, getCard, clearCards } from '../src/ui/tool-card.mjs';
import { detailFor } from '../src/ui/tool-details.mjs';
import { renderDiff, renderMarkdown } from '../src/terminal/ansi.mjs';
import { renderMissionReport } from '../src/ui/mission-report.mjs';

let cases = 0;
const checkWidth = (text, columns) => {
  for (const line of text.split('\n')) assert.ok(cellWidth(line) < columns, columns + ' columns: ' + strip(line));
  cases++;
};
const original = { ...term() };
const command = ['python3 <<\'PY\'', ...Array.from({ length: 240 }, (_, i) => 'print("step_' + i + '")'), 'PY', 'printf AFTER_SCRIPT'].join('\n');
const diff = buildFileDiff({ filePath: '/work/auth.ts', cwd: '/work', before: 'function auth(token) {\n  return verify(token);\n}\n', after: 'function auth(token) {\n  return verify(token, scope);\n}\n' });
try {
  for (const appearance of ['light', 'dark']) for (const colorLevel of ['truecolor', 'ansi256', 'ansi16', 'none']) {
    for (const columns of [24, 40, 60, 80, 120]) {
      _setForTesting({ columns, appearance, color: colorLevel !== 'none', colorLevel, unicode: true });
      checkWidth(renderFileDiffs({ file_diff: diff }), columns);
      checkWidth(renderDiff(diff.unified), columns);
      const fence = String.fromCharCode(96).repeat(3);
      checkWidth(renderMarkdown(fence + 'diff\n' + diff.unified + '\n' + fence), columns);
      const long = 'curl https://example.test/' + 'very-long-path-'.repeat(10);
      checkWidth(formatCardHead('shell', { command: long, cwd: '/work/project/long path with spaces' }, { columns }), columns);
      checkWidth(formatCard({ tool: 'shell', args: { command: 'npm test' }, result: { success: false, exit_code: 1, stderr: 'failed: ' + '語'.repeat(50) }, columns }), columns);
      checkWidth(detailFor({ tool: 'shell', args: { command, cwd: '/work/project' }, result: { success: true, output: 'all done', exit_code: 0 } }), columns);
      checkWidth(renderMissionReport({ task: 'Verify authentication', filesChanged: ['src/auth.ts'], filesRead: ['src/config.ts'], toolCounts: { shell: 1 }, testsPass: { passed: 12, total: 12 } }), columns);
    }
  }
  _setForTesting({ columns: 80, color: true, colorLevel: 'ansi16' });
  const highlighted = renderFileDiffs({ file_diff: diff });
  assert.ok(highlighted.includes('\x1b[4m'), 'changed words are underlined');
  assert.ok(highlighted.includes('\x1b[31m') && highlighted.includes('\x1b[32m'));
  const [removed, added] = changedWords('return verify(token);', 'return verify(token, scope);');
  assert.equal(removed.map(w => w.text).join(''), 'return verify(token);');
  assert.equal(added.filter(w => w.changed).map(w => w.text).join(''), ', scope');

  const surfaceDiff = '--- a/layout.js\n+++ b/layout.js\n@@ -1,3 +1,3 @@\n-const label = "old";\n+const label = "new";\n-\n+\t' + '語'.repeat(70) + '\n context();\n';
  for (const appearance of ['light', 'dark']) for (const colorLevel of ['truecolor', 'ansi256', 'ansi16', 'none']) {
    _setForTesting({ appearance, colorLevel, color: colorLevel !== 'none', columns: 40 });
    const surfaceOutput = renderUnifiedDiff(surfaceDiff, { indent: '    ' });
    checkWidth(surfaceOutput, 40);
    const shaded = ['truecolor', 'ansi256'].includes(colorLevel);
    assert.equal(surfaceOutput.includes('\x1b[48;'), shaded);
    if (shaded) {
      for (const role of ['keyword', 'string']) assert.ok(surfaceOutput.includes(paint.token('diffSyntax.' + role).open), 'syntax ink survives row and word backgrounds');
      assert.ok(!surfaceOutput.includes(paint.token('state.success').open + 'const'), 'addition does not repaint the code green');
      for (const key of ['addLine', 'removeLine', 'addWord', 'removeWord']) assert.ok(surfaceOutput.includes(paint.token('diff.' + key).open));
      const gitResult = renderCommandResult({ success: true, output: surfaceDiff }, { args: { command: 'git diff' }, full: true });
      const gitDetails = detailFor({ tool: 'shell', args: { command: 'git diff' }, result: { success: true, output: surfaceDiff } });
      for (const output of [gitResult, gitDetails]) {
        assert.ok(output.includes(paint.token('diff.addLine').open), 'git diff command output uses the shared surfaces');
        checkWidth(output, 40);
      }
      const rows = surfaceOutput.split('\n').filter(row => row.includes('\x1b[48;'));
      assert.ok(rows.length > 4, 'wrapped continuations retain their surface');
      for (const row of rows) {
        assert.ok(row.startsWith('    \x1b[48;'), 'indent stays outside the background');
        assert.equal(cellWidth(row), 39, 'row shading ends one cell before terminal autowrap');
        assert.ok(row.endsWith('\x1b[49m'), 'row background is reset');
      }
      const context = surfaceOutput.split('\n').find(row => strip(row).includes('context();'));
      assert.ok(!context.includes('\x1b[48;'), 'context stays unshaded');
    }
  }
  for (const appearance of ['light', 'dark']) {
    _setForTesting({ appearance, color: true, colorLevel: 'truecolor', columns: 120 });
    const output = renderUnifiedDiff('--- a/demo.mjs\n+++ b/demo.mjs\n@@ -1,2 +1,2 @@\n-const text = "old return"; // old const\n+const text = "new return"; // new const\n-const count = 41;\n+const count = 42;');
    assert.ok(output.includes(paint.diffSyntax.string(paint.bold(paint.underline('new')))), 'changed substring keeps the whole string token color');
    assert.ok(output.includes(paint.diffSyntax.comment(paint.bold(paint.underline('new')))), 'changed comment keeps comment ink');
    assert.ok(output.includes(paint.diffSyntax.literal(paint.bold(paint.underline('42')))), 'changed number keeps amber ink');
    assert.ok(!output.includes(paint.diffSyntax.keyword('return')), 'keywords inside strings are not re-lexed as code');
  }
  _setForTesting({ columns: 80, color: true, colorLevel: 'ansi16' });

  const large = buildFileDiff({ filePath: 'src/many.js', before: '', after: Array.from({ length: 450 }, (_, i) => 'line_' + i).join('\n') });
  const detail = strip(detailFor({ tool: 'write_file', args: { file_path: 'src/many.js' }, result: { file_diff: large } }));
  assert.ok(detail.includes('line_449'), 'expanded diffs must not stop at 60 lines');
  const full = strip(detailFor({ tool: 'shell', args: { command }, result: { success: true, output: Array.from({ length: 80 }, (_, i) => 'out_' + i).join('\n') } }));
  assert.ok(full.includes('step_239') && full.includes('AFTER_SCRIPT') && full.includes('out_79'));
  const submitted = Array.from({ length: 90 }, (_, i) => 'submitted_' + i).join('\n');
  assert.ok(strip(detailFor({ tool: 'write_file', args: { file_path: 'src/large.js', content: submitted }, result: { success: true } })).includes('submitted_89'));
  const fallback = strip(detailFor({ tool: 'edit_file', args: { path: 'src/large.js', old_string: submitted, new_string: submitted + '\nnew_tail' }, result: { success: true } }));
  assert.ok(fallback.includes('submitted_89') && fallback.includes('new_tail') && fallback.includes('line numbers unavailable'));
  const scoped = strip(formatCardHead('shell', { cwd: '/base', command: 'cd child && npm test' }));
  assert.ok(scoped.includes('$ cd child && npm test') && scoped.includes('cwd  /base'));
  const originalArgs = { command: 'cd /work/project && npm test' };
  clearCards();
  recordCard({ id: 'keep', tool: 'shell', args: originalArgs, startedAt: 123, cwd: '/work/project', source: 'plugin reviewer' });
  recordCard({ id: 'keep', tool: 'shell', args: undefined, result: { success: true } });
  assert.deepEqual(getCard('keep').args, originalArgs);
  assert.equal(getCard('keep').source, 'plugin reviewer');
  assert.equal(getCard('keep').startedAt, 123);
  assert.ok(strip(detailFor(getCard('keep'))).includes('cd /work/project && npm test'));

  const multi = 'diff --git a/one b/one\n--- a/one\n+++ b/one\n@@ -0,0 +1,2 @@\n+first\n+second\n\\ No newline at end of file\n'
    + 'diff --git a/two b/two\n--- a/two\n+++ b/two\n@@ -8,1 +8,0 @@\n-gone\n';
  const parsed = parseUnifiedDiff(multi);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].hunks[0].old_start, 0);
  assert.equal(parsed[0].hunks[0].old_count, 0);
  assert.equal(parsed[0].hunks[0].lines[2].type, 'meta');
  const rendered = strip(renderUnifiedDiff(multi));
  assert.match(rendered, /one \+2 −0/);
  assert.match(rendered, /two \+0 −1/);
  assert.match(rendered, /8\s+- gone/);
  assert.match(rendered, /No newline at end of file/);
  assert.ok(strip(renderFileDiffs({ file_diff: large }, { maxLines: 3 })).includes('447 diff lines omitted'));
  assert.ok(strip(renderFileDiffs({ file_diff: { ...diff, truncated: true, truncated_line_count: 4 } })).includes('4 lines omitted upstream'));

  for (const secret of [
    { file_diff: { ...diff, relative_path: '.env', redacted: true } },
    '--- a/.env.local\n+++ b/.env.local\n@@ -1 +1 @@\n-SECRET_OLD\n+SECRET_NEW\n',
  ]) {
    const hidden = strip(renderFileDiffs(secret));
    assert.match(hidden, /redacted/);
    assert.ok(!hidden.includes('SECRET_') && !hidden.includes('verify('));
  }
  for (const sample of ['A=1 npm test -- --reporter=json', 'echo "a | b" > file && cat file', 'curl -H "x:y" https://example.test']) {
    assert.equal(commandRuns(sample).map(run => run.text).join(''), sample);
  }
  assert.equal(commandStatus({ success: false, exit_code: 0 }).tone, 'danger');
  assert.equal(commandStatus({ exit_code: '0' }).tone, 'success');
  assert.equal(commandStatus({}).tone, 'muted');
  assert.ok(!commandStatus({ _observation_timeout: true, exit_code: 124 }).text.includes('exit 124'));
  assert.ok(strip(renderCommandResult({ success: false, exit_code: 2, stderr: 'SyntaxError: missing token' })).includes('SyntaxError'));
  assert.equal(toolSource({ _plugin: 'reviewer', _mcp_server: 'git', workflow_name: 'ship' }), 'plugin reviewer · MCP git · workflow ship');
  const action = strip(workspaceAction("src/a'b.js", { cwd: '/work' })).replace(/\n/g, '');
  assert.ok(action.includes('bahulam workspace open'));
  assert.ok(action.includes("'\"'\"'"), 'file paths must be shell-quoted');
  assert.equal(workspaceAction('bad\npath'), '');


  // Exercise the event-facing path, not just pure fixtures.
  const { renderToolCall, renderToolResult, stopSpinner } = await import('../src/terminal/repl-render.mjs');
  const { runtime } = await import('../src/terminal/repl-state.mjs');
  const stderr = process.stderr.write;
  let live = '';
  try {
    _setForTesting({ color: false, plain: true, isTTY: false, columns: 40 });
    process.stderr.write = chunk => { live += String(chunk); return true; };
    const liveCommand = 'npm test --reporter=dot --grep=authorization --runInBand';
    renderToolCall({ call_id: 'live-card', tool: 'shell', args: { command: liveCommand, cwd: '/work/app' }, _plugin: 'reviewer' });
    renderToolResult({ call_id: 'live-card', tool: 'shell', success: true, exit_code: 0, output: '12 tests passed', duration_ms: 1200 });
    assert.match(live, /Command/);
    assert.match(live, /plugin reviewer/);
    assert.match(live, /exit 0/);
    assert.match(live, /12 tests passed/);
    assert.equal(getCard('live-card').args.command, liveCommand);
    checkWidth(live, 40);
  } finally {
    stopSpinner();
    runtime.pendingHead = null;
    process.stderr.write = stderr;
  }

  _setForTesting({ color: false, unicode: false, columns: 80 });
  for (const text of [
    renderFileDiffs({ file_diff: diff }), formatCardHead('shell', { command: 'npm test' }),
    renderCommandResult({ success: true, exit_code: 0 }), renderMissionReport({ testsPass: null }),
  ]) {
    assert.ok(!text.includes('\x1b'));
    assert.match(text, /^[\x00-\x7f]*$/);
  }
  assert.ok(strip(renderMissionReport({})).includes('No test totals reported'));
  assert.ok(!strip(renderMissionReport({})).includes('tests pass'));
  assert.ok(wrapCode('bad\x1b[2Jcommand', undefined).includes('\\x1b'), 'embedded cursor controls must be visible text');
} finally {
  clearCards();
  _setForTesting(original);
}
console.log('Code cards: ' + cases + ' layout cases plus diff, command, source and redaction regressions passed.');
