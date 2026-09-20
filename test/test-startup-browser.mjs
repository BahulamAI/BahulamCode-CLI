/** Isolated startup/dock regression in an actual xterm; no backend or credentials. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { term, _setForTesting } from '../src/ui/term.mjs';
import { renderBanner } from '../src/ui/banner.mjs';
import * as dock from '../src/ui/input-dock.mjs';
import { renderResumePreview } from '../src/terminal/repl-resume.mjs';
import { wrapCode } from '../src/ui/code-layout.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const xterm = require.resolve(process.env.XTERM_MODULE || 'xterm');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-startup-visual-'));
const original = { ...term() };
function capture(columns, appearance, previousRows, resumed) {
  let bytes = Array.from({ length: previousRows }, (_, i) => 'OLD SHELL OUTPUT ' + i + '\n').join('');
  const stdout = process.stdout.write, stderr = process.stderr.write;
  const listeners = new Map(['exit', 'SIGTERM'].map(event => [event, new Set(process.listeners(event))]));
  try {
    _setForTesting({ columns, rows: 30, appearance, isTTY: true, plain: false, color: true,
      colorLevel: 'truecolor', unicode: true, fixedInput: true, ttyMode: 'rich' });
    process.stdout.write = process.stderr.write = chunk => { bytes += String(chunk); return true; };
    dock.mountInputDock({ preserveScrollback: true });
    if (resumed) {
      process.stderr.write(wrapCode('Resumed session: 100 messages', undefined, { indent: '  ' }) + '\n');
      renderResumePreview({
        historyMode: 'full',
        history: Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'SAVED MESSAGE ' + i + (i === 99 ? ' 語 e\u0301' : '') })),
      }, { previewOnly: true, startup: true });
    } else {
      process.stderr.write(renderBanner('test'));
      process.stderr.write(wrapCode('LOCAL READY', undefined, { indent: '  ' }) + '\n');
    }
    dock.renderDockInput('You > ', 'keep this draft', { context: 'code', meta: 'project', tips: 'Enter send' });
    process.stderr.write(wrapCode('LATE CONNECTION NOTICE', undefined, { indent: '  ' }) + '\n');
    process.stderr.write(wrapCode('FIRST NEW MESSAGE', undefined, { indent: '  ' }) + '\n');
    return bytes;
  } finally {
    dock.unmountInputDock();
    // Each capture represents a separate CLI process; discard its shutdown hooks.
    for (const [event, original] of listeners) for (const listener of process.listeners(event)) {
      if (!original.has(listener)) process.removeListener(event, listener);
    }
    process.stdout.write = stdout; process.stderr.write = stderr; _setForTesting(original);
  }
}
const browser = await chromium.launch({ headless: true, timeout: 20000,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
let count = 0;
try {
  for (const appearance of ['light', 'dark']) for (const columns of [40, 80]) for (const previousRows of [0, 5]) for (const resumed of [false, true]) {
    const bytes = capture(columns, appearance, previousRows, resumed);
    assert.ok(!bytes.includes('\x1b[3J'), 'never erase shell scrollback');
    const page = await browser.newPage({ viewport: { width: columns * 10 + 48, height: 650 }, deviceScaleFactor: 2 });
    await page.setContent('<div id="terminal"></div>');
    await page.addStyleTag({ path: path.resolve(path.dirname(xterm), '../css/xterm.css') });
    await page.addStyleTag({ content: 'body{margin:24px;background:' + (appearance === 'light' ? '#FAF9F6' : '#1C1F29') + '}' });
    await page.addScriptTag({ path: xterm });
    const screen = await page.evaluate(async ({ bytes, columns, appearance }) => {
      const t = new window.Terminal({ cols: columns, rows: 30, convertEol: true, scrollback: 1000, fontSize: 14, fontFamily: 'Menlo, monospace',
        theme: appearance === 'light' ? { background: '#FAF9F6', foreground: '#202331' } : { background: '#1C1F29', foreground: '#F0F1F8' } });
      t.open(document.getElementById('terminal'));
      await new Promise(resolve => t.write(bytes, resolve));
      const all = Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true) || '');
      return { all: all.join('\n'), visible: all.slice(t.buffer.active.baseY).join('\n') };
    }, { bytes, columns, appearance });
    const startupMarkers = resumed ? ['Resumed session: 100 messages', 'SAVED MESSAGE 99'] : ['abundance in your terminal', 'LOCAL READY'];
    for (const marker of [...startupMarkers, 'LATE CONNECTION NOTICE', 'FIRST NEW MESSAGE', 'keep this draft']) {
      assert.ok(screen.visible.includes(marker), columns + ': missing or overwritten ' + marker + '\n' + screen.visible);
    }
    if (resumed) assert.ok(!screen.all.includes('abundance in your terminal') && !screen.all.includes('LOCAL READY'));
    if (previousRows) assert.ok(screen.all.includes('OLD SHELL OUTPUT 0'));
    await page.locator('.xterm-screen').screenshot({ path: path.join(artifacts, appearance + '-' + columns + '-prior' + previousRows + (resumed ? '-resume' : '-fresh') + '.png') });
    await page.close();
    count++;
  }
  console.log(count + ' startup overlap/scrollback snapshots passed: ' + artifacts);
} finally { _setForTesting(original); await browser.close(); }
