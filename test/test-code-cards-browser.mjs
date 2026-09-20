/**
 * Optional terminal visual test. Uses real renderers and xterm, no backend.
 * PLAYWRIGHT_MODULE / XTERM_MODULE may point to existing installations.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { term, _setForTesting } from '../src/ui/term.mjs';
import { paint, DIFF_BACKGROUNDS, strip } from '../src/ui/palette.mjs';
import { cellWidth } from '../src/ui/render-queue.mjs';
import { buildFileDiff } from '../src/core/file-diff.mjs';
import { renderFileDiffs } from '../src/ui/diff.mjs';
import { formatCard } from '../src/ui/tool-card.mjs';
import { detailFor } from '../src/ui/tool-details.mjs';
import { renderMissionReport } from '../src/ui/mission-report.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const xtermJs = require.resolve(process.env.XTERM_MODULE || 'xterm');
const artifacts = process.env.BROWSER_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-code-cards-'));
const original = { ...term() };
const fileDiff = buildFileDiff({
  filePath: 'src/auth.ts',
  before: 'export function authorize(token) {\n  const session = verify(token, "read");\n  return session.user;\n}\n',
  after: 'export function authorize(token, scope) {\n  const session = verify(token, scope);\n  return session.user;\n}\n',
});
let count = 0;
const browser = await chromium.launch({ headless: true, timeout: 20000,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  for (const appearance of ['light', 'dark']) for (const colorLevel of ['truecolor', 'ansi256']) for (const columns of [40, 80, 120]) {
    _setForTesting({ appearance, columns, color: true, colorLevel, unicode: true });
    const fixtures = {
      changes: [
        renderFileDiffs({ file_diff: fileDiff }),
        formatCard({ tool: 'shell', args: { command: 'npm test -- auth', cwd: '/work/project' },
          result: { success: true, exit_code: 0, stdout: '12 tests passed', _plugin: 'reviewer' }, durationMs: 1200 }),
        renderMissionReport({ task: 'Require authorization scope', filesChanged: ['src/auth.ts'], toolCounts: { edit_file: 1, shell: 1 }, testsPass: { passed: 12, total: 12 }, durationS: 4.2 }),
      ].join('\n\n'),
      details: [
        detailFor({ tool: 'shell', source: 'workflow review', cwd: '/work/project',
          args: { command: "python3 <<'PY'\nprint('check auth')\nPY\nnpm test -- auth" },
          result: { success: false, exit_code: 1, stderr: 'Expected scope:read but got scope:write' }, durationMs: 2100 }),
        detailFor({ tool: 'edit_file', args: { file_path: 'src/auth.ts' }, cwd: '/work/project', source: 'plugin reviewer', result: { success: true, file_diff: fileDiff } }),
      ].join('\n\n'),
      git: detailFor({ tool: 'shell', args: { command: 'git diff -- src/auth.ts', cwd: '/work/project' },
        result: { success: true, exit_code: 0, output: fileDiff.unified } }),
    };
    for (const [name, text] of Object.entries(fixtures)) {
      for (const line of text.split('\n')) assert.ok(cellWidth(line) < columns, strip(line));
      const rows = Math.max(24, text.split('\n').length + 2);
      const page = await browser.newPage({ viewport: { width: columns * 10 + 48, height: rows * 18 + 48 }, deviceScaleFactor: 2 });
      await page.setContent('<html><body><div id="terminal"></div></body></html>');
      await page.addStyleTag({ path: path.resolve(path.dirname(xtermJs), '../css/xterm.css') });
      await page.addStyleTag({ content: 'body{margin:24px;background:' + (appearance === 'light' ? '#FAF9F6' : '#1C1F29') + '}' });
      await page.addScriptTag({ path: xtermJs });
      const screen = await page.evaluate(async ({ columns, rows, text, appearance }) => {
        const t = new window.Terminal({ cols: columns, rows, fontSize: 14, fontFamily: 'Menlo, monospace', convertEol: true, cursorBlink: false,
          theme: appearance === 'light' ? { background: '#FAF9F6', foreground: '#202331' } : { background: '#1C1F29', foreground: '#F0F1F8' } });
        t.open(document.getElementById('terminal'));
        await new Promise(resolve => t.write(text + '\x1b[?25l', resolve));
        return Array.from({ length: rows }, (_, i) => {
          const line = t.buffer.active.getLine(i);
          return { text: line?.translateToString(true) || '', wrapped: line?.isWrapped || false,
            backgrounds: Array.from({ length: columns }, (_, col) => {
              const cell = line?.getCell(col);
              return !cell || cell.isBgDefault() ? null : cell.getBgColor();
            }),
          };
        });
      }, { columns, rows, text, appearance });
      assert.ok(screen.every(line => !line.wrapped), 'no terminal-autowrapped lines at ' + columns);
      const tokens = DIFF_BACKGROUNDS[appearance];
      const bgValue = key => colorLevel === 'truecolor' ? tokens[key].rgb.reduce((n, part) => n * 256 + part, 0) : tokens[key].ansi256;
      const sourceRows = text.split('\n');
      const seenWords = new Set();
      for (const [index, row] of screen.entries()) {
        const source = sourceRows[index] || '';
        const side = source.includes(paint.token('diff.addLine').open) ? 'add'
          : source.includes(paint.token('diff.removeLine').open) ? 'remove' : null;
        if (!side) {
          assert.ok(row.backgrounds.every(bg => bg === null), 'no shading leaks into context, commands or next messages');
          continue;
        }
        const lineBg = bgValue('diff.' + side + 'Line');
        const wordBg = bgValue('diff.' + side + 'Word');
        const inset = source.indexOf(paint.token('diff.' + side + 'Line').open);
        assert.ok(row.backgrounds.slice(0, inset).every(bg => bg === null), 'transcript indent is unshaded');
        assert.equal(row.backgrounds.at(-1), null, 'last terminal cell stays unshaded');
        assert.equal(row.backgrounds.at(-2), lineBg, 'word backgrounds reset to row background');
        assert.ok(row.backgrounds.slice(inset, -1).every(bg => bg === lineBg || bg === wordBg), 'entire wrapped row has the correct background');
        if (row.backgrounds.includes(wordBg)) seenWords.add(side);
      }
      assert.deepEqual([...seenWords].sort(), ['add', 'remove'], 'both changed-word backgrounds reach actual terminal cells');
      const visible = screen.map(line => line.text).join('\n');
      if (name === 'changes') {
        assert.match(visible, /src\/auth\.ts/);
        assert.match(visible, /12 tests passed/);
        assert.match(visible, /12\/12 tests pass/);
      } else if (name === 'details') {
        assert.match(visible, /Full command/);
        assert.match(visible, /npm test -- auth/);
        assert.match(visible, /exit 1/);
        assert.match(visible, /new workspace/);
      } else {
        assert.match(visible, /git diff -- src\/auth\.ts/);
        assert.match(visible, /exit 0/);
        assert.match(visible, /stdout/);
      }
      await page.locator('.xterm-screen').screenshot({ path: path.join(artifacts, appearance + '-' + colorLevel + '-' + columns + '-' + name + '.png') });
      await page.close();
      count++;
    }
  }
  console.log(count + ' code-card terminal snapshots verified. Screenshots: ' + artifacts);
} finally {
  _setForTesting(original);
  await browser.close();
}
