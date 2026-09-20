/** Real terminal checks for grouped conversation sections and soft accents. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOKENS, LIGHT_TOKENS } from '../src/ui/palette.mjs';
import { captureTranscript } from './fixtures/transcript-sections.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const xterm = require.resolve(process.env.XTERM_MODULE || 'xterm');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-transcript-'));
const browser = await chromium.launch({ headless: true, timeout: 20000,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
let count = 0;
try {
  for (const appearance of ['light', 'dark']) for (const columns of [40, 80, 120]) for (const docked of [false, true]) {
    const bytes = captureTranscript({ columns, appearance, docked });
    const page = await browser.newPage({ viewport: { width: columns * 10 + 48, height: 950 }, deviceScaleFactor: 2 });
    await page.setContent('<div id="terminal"></div>');
    await page.addStyleTag({ path: path.resolve(path.dirname(xterm), '../css/xterm.css') });
    await page.addStyleTag({ content: 'body{margin:24px;background:' + (appearance === 'light' ? '#FAF9F6' : '#1C1F29') + '}' });
    await page.addScriptTag({ path: xterm });
    const screen = await page.evaluate(async ({ bytes, columns, appearance }) => {
      const t = new window.Terminal({ cols: columns, rows: 48, convertEol: true, scrollback: 1000,
        fontSize: 14, fontFamily: 'Menlo, monospace', cursorBlink: false,
        theme: appearance === 'light' ? { background: '#FAF9F6', foreground: '#202331' } : { background: '#1C1F29', foreground: '#F0F1F8' } });
      t.open(document.getElementById('terminal'));
      await new Promise(resolve => t.write(bytes + '\x1b[?25l', resolve));
      return Array.from({ length: t.buffer.active.length }, (_, i) => {
        const line = t.buffer.active.getLine(i);
        return { text: line?.translateToString(true) || '', wrapped: line?.isWrapped,
          foregrounds: Array.from({ length: columns }, (_, col) => {
            const cell = line?.getCell(col);
            return cell?.isFgRGB() && cell.getChars().trim() ? cell.getFgColor() : null;
          }),
        };
      });
    }, { bytes, columns, appearance });
    const transcript = screen.map(line => line.text).join('\n');
    assert.equal((transcript.match(/bahulam ›/g) || []).length, 3, transcript);
    assert.equal((transcript.match(/you ›/g) || []).length, 2, transcript);
    assert.equal((transcript.match(/^  ─+$/gm) || []).length, 5, 'one rule per section, not per streaming chunk/tool result');
    for (const content of ['12 checks passed', 'retries', 'Authorization now checks scope.']) assert.ok(transcript.includes(content), columns + '/' + docked + ': missing ' + content + '\n' + transcript);
    if (docked) assert.ok(transcript.includes('keep this draft'));
    assert.ok(screen.every(line => !line.wrapped), 'no terminal autowrap at ' + columns);
    const tokens = appearance === 'light' ? LIGHT_TOKENS : TOKENS;
    const actual = new Set(screen.flatMap(line => line.foregrounds));
    for (const key of ['brand.primary', 'syntax.keyword', 'syntax.string', 'syntax.literal', 'state.success']) {
      const color = tokens[key].rgb.reduce((n, channel) => n * 256 + channel, 0);
      assert.ok(actual.has(color), key + ' reaches the terminal');
    }
    const finalReply = screen.find(line => line.text.includes('Authorization now checks scope.'));
    assert.ok(finalReply.foregrounds.every(color => color === null), 'ordinary prose stays neutral');
    await page.locator('.xterm-screen').screenshot({ path: path.join(artifacts, appearance + '-' + columns + '-' + (docked ? 'docked' : 'flow') + '.png') });
    await page.close();
    count++;
  }
  console.log(count + ' transcript grouping/palette snapshots verified: ' + artifacts);
} finally { await browser.close(); }
