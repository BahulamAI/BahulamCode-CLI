import assert from 'node:assert/strict';
import { term, _setForTesting } from '../src/ui/term.mjs';
import { strip, width } from '../src/ui/palette.mjs';
import { renderApprovalDockPrompt, renderApprovalPrompt, defaultOptions, TIERS } from '../src/ui/approval.mjs';
import { dockContentWidth, dockOverlayCapacity } from '../src/ui/input-dock.mjs';
import { dockHeading, inputHints, sgr } from '../src/ui/chrome.mjs';
import { wrapToLines } from '../src/ui/text-layout.mjs';
import { EventFormatter } from '../src/ui/formatter.mjs';

const originalTerm = { ...term() };
const script = ["python3 <<'PY'", ...Array.from({ length: 30 }, (_, i) => 'print("item_' + i + '")'), 'PY', 'npm publish'].join('\n');
const base = { tool: 'shell', args: { command: script, cwd: '/work/project' }, tier: TIERS.SHELL_MEDIUM };
let cases = 0;
try {
  for (const appearance of ['light', 'dark']) {
    for (const columns of [40, 60, 80, 120]) {
      for (const rows of [18, 24, 40]) {
        _setForTesting({ color: true, colorLevel: 'truecolor', unicode: true, appearance, columns, rows });
        const first = renderApprovalDockPrompt(base);
        assert.ok(first.fits, columns + 'x' + rows);
        assert.ok(first.pageCount > 1);
        const all = [];
        for (let page = 0; page < first.pageCount; page++) {
          const frame = renderApprovalDockPrompt({ ...base, page });
          assert.equal(frame.lines.length, first.lines.length, 'page height stays stable');
          assert.ok(frame.lines.length <= dockOverlayCapacity(rows));
          for (const line of frame.lines) assert.ok(width(line) <= dockContentWidth(columns), strip(line));
          const text = strip(frame.lines.join('\n'));
          assert.match(text, /risk\s+publish/);
          assert.match(text, /\[y\] approve once/);
          assert.match(text, /\[n\] cancel/);
          assert.match(text, /allow similar \(session\)/);
          all.push(text);
          cases++;
        }
        const combined = all.join('\n');
        for (let i = 0; i < 30; i++) assert.ok(combined.includes('print("item_' + i + '")'));
        assert.match(combined, /PY/);
        assert.match(combined, /npm publish/);
        assert.match(combined, /\/work\/project/);
        for (let selected = 0; selected < 3; selected++) {
          assert.equal(renderApprovalDockPrompt({ ...base, selected }).lines.length, first.lines.length);
        }
        assert.equal(renderApprovalDockPrompt({ ...base, page: 10000 }).page, first.pageCount - 1);
        assert.ok(width(dockHeading('bahulam. code', 'very long model / context / elapsed metadata', columns - 1)) < columns);
        assert.ok(width(inputHints()) <= columns - 5);
        assert.match(inputHints({ running: true }), /Enter send.*Esc cancel/);
      }
    }
  }
  _setForTesting({ columns: 80, rows: 24, color: false, unicode: false });
  const expanded = strip(renderApprovalPrompt({ ...base, showDetails: true }));
  assert.match(expanded, /npm publish/, 'fallback details include trailing commands');
  const coloredToken = '\x1b[38;2;48;59;160m' + 'a'.repeat(180) + '\x1b[0m';
  const wrapped = wrapToLines(coloredToken, 35);
  assert.equal(strip(wrapped.join('')), 'a'.repeat(180));
  assert.ok(wrapped.every(line => width(line) <= 35));
  const simple = renderApprovalDockPrompt({ ...base, args: { command: 'npm test' } });
  assert.match(JSON.stringify(simple), /^[\x00-\x7f]*$/);
  assert.ok(!JSON.stringify(simple).includes('\\u001b'));
  assert.equal(sgr.bold + sgr.muted + sgr.reset, '');
  const secret = renderApprovalDockPrompt({
    tool: 'edit_file', tier: TIERS.PROTECTED_EDIT,
    args: { file_path: '.env.local', search: 'API_KEY=old-secret', replace: 'API_KEY=new-secret' },
  });
  assert.ok(!JSON.stringify(secret).includes('old-secret'));
  assert.ok(!JSON.stringify(secret).includes('new-secret'));
  assert.ok(!defaultOptions(TIERS.DESTRUCTIVE, base).some(o => o.value.startsWith('allow')));
  const project = renderApprovalDockPrompt({ ...base, options: [{ key: 'p', value: 'allow-project', label: 'trust project' }] });
  assert.match(strip(project.lines.join('\n')), /trust project \(project\)/);
  _setForTesting({ columns: 20, rows: 10 });
  assert.equal(renderApprovalDockPrompt(base).fits, false, 'tiny viewport must request transcript fallback');

  // NO_COLOR applies to workflow output too; failed writes are not reported as changes.
  const stderr = process.stderr.write;
  const stdout = process.stdout.write;
  let output = '';
  try {
    process.stdout.write = process.stderr.write = chunk => { output += String(chunk); return true; };
    const formatter = new EventFormatter({ verbose: true });
    formatter.render({ type: 'content', data: { text: 'I will inspect the code.' } });
    formatter.render({ type: 'tool_done', data: { tool: 'write_file', success: false, args: { file_path: 'not-written.js' } } });
    formatter.render({ type: 'complete', data: { success: false } });
    assert.equal(formatter.changes.length, 0);
    assert.match(output, /Bahulam/);
    assert.match(output, /failed/);
    assert.match(output, /Not completed/);
    assert.ok(!output.includes('\x1b'));
    assert.ok(!output.includes('Written'));
  } finally {
    process.stderr.write = stderr;
    process.stdout.write = stdout;
  }
} finally {
  _setForTesting(originalTerm);
}
console.log('Approval layout: ' + cases + ' paged frames checked across themes and terminal sizes.');
