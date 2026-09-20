/**
 * Optional actual-terminal visual smoke test (no backend or credentials).
 * PLAYWRIGHT_MODULE and XTERM_MODULE can point at existing installations.
 * BROWSER_EXECUTABLE optionally selects system Chrome.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { term, _setForTesting } from '../src/ui/term.mjs';
import * as dock from '../src/ui/input-dock.mjs';
import { renderApprovalDockPrompt, TIERS } from '../src/ui/approval.mjs';
import { inputHints } from '../src/ui/chrome.mjs';
import { transcriptHeader, transcriptLine } from '../src/ui/transcript-block.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const xtermJs = require.resolve(process.env.XTERM_MODULE || 'xterm');
const xtermCss = path.resolve(path.dirname(xtermJs), '../css/xterm.css');
const artifacts = process.env.BROWSER_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-docks-'));
const originalTerm = { ...term() };

function capture(appearance) {
  let bytes = '\x1b[2J\x1b[H';
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const frames = [];
  const take = name => { frames.push({ name, bytes, columns: term().columns, rows: term().rows }); bytes = ''; };
  const review = page => dock.renderDockOverlay(renderApprovalDockPrompt({
    tool: 'shell', tier: TIERS.SHELL_MEDIUM, page,
    args: { command: ['npm test', ...Array.from({ length: 15 }, (_, i) => 'echo step_' + i), 'npm publish'].join('\n'), cwd: '/work/project' },
    why: 'Review this command before it runs.',
  }));
  try {
    _setForTesting({ isTTY: true, plain: false, fixedInput: true, ttyMode: 'rich',
      color: true, colorLevel: 'truecolor', unicode: true, appearance, columns: 80, rows: 24 });
    process.stdout.write = process.stderr.write = chunk => { bytes += String(chunk); return true; };
    dock.mountInputDock();
    process.stdout.write(transcriptHeader('You', { tone: 'user' }) + '\n');
    process.stdout.write(transcriptLine('Review the changes and run the checks.') + '\n\n');
    process.stdout.write(transcriptHeader('Bahulam') + '\n');
    process.stdout.write(transcriptLine('The changes are ready for verification.') + '\n');
    dock.renderDockInput('You › ', 'Ready input text', { context: 'code / 12k tokens', meta: 'project / feature / turn 2', tips: inputHints() });
    take('input-80');
    dock.renderDockInput('+ add context > ', 'check the API too', { context: 'working', meta: 'project / feature', tips: inputHints({ running: true }) });
    take('execution-input');
    for (let tick = 1; tick <= 4; tick++) {
      dock.refreshDockMetadata({ context: tick + 's elapsed', meta: 'project / feature' });
      process.stdout.write('Working update ' + tick + '\n');
    }
    take('execution-after-refresh');
    review(0);
    take('approval-80');
    // Reproduce the old timer race and concurrent transcript output.
    dock.renderDockInput('You › ', 'TIMER MUST NOT REPLACE APPROVAL');
    for (let i = 0; i < 30; i++) process.stdout.write('Background update ' + i + '\n');
    dock.redrawDockInput();
    take('approval-after-refresh');
    review(1);
    take('approval-page-2');
    _setForTesting({ columns: 40, rows: 18 });
    process.stdout.emit('resize');
    review(0);
    take('approval-40');
    dock.dismissDockOverlay();
    dock.renderDockInput('You › ', 'Continue', { context: 'code / 12k tokens', meta: 'project / feature', tips: inputHints() });
    take('input-40');
  } finally {
    dock.unmountInputDock();
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    _setForTesting(originalTerm);
  }
  return frames;
}

const browser = await chromium.launch({ headless: true,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  for (const appearance of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 760, height: 540 }, deviceScaleFactor: 2 });
    await page.setContent('<html><body><div id="terminal"></div></body></html>');
    await page.addStyleTag({ path: xtermCss });
    await page.addStyleTag({ content: 'body{margin:24px;background:' + (appearance === 'light' ? '#FAF9F6' : '#1C1F29') + '}' });
    await page.addScriptTag({ path: xtermJs });
    await page.evaluate(appearance => {
      window.preview = new window.Terminal({
        cols: 80, rows: 24, scrollback: 1000, fontSize: 14, fontFamily: 'Menlo, monospace',
        convertEol: true, cursorBlink: false,
        theme: appearance === 'light' ? { background: '#FAF9F6', foreground: '#202331', cursor: '#303BA0' }
          : { background: '#1C1F29', foreground: '#F0F1F8', cursor: '#BEC6FF' },
      });
      window.preview.open(document.getElementById('terminal'));
    }, appearance);
    let executionCursor;
    for (const frame of capture(appearance)) {
      const visible = await page.evaluate(async ({ columns, rows, bytes }) => {
        const t = window.preview;
        if (t.cols !== columns || t.rows !== rows) t.resize(columns, rows);
        await new Promise(resolve => t.write(bytes, resolve));
        return Array.from({ length: t.rows }, (_, row) => t.buffer.active.getLine(t.buffer.active.baseY + row)?.translateToString(true) || '').join('\n');
      }, frame);
      if (frame.name.startsWith('execution')) {
        assert.match(visible, /\+ add context > check the API too/);
        assert.ok(!visible.includes('Ready input text'));
        const cursor = await page.evaluate(() => ({ x: window.preview.buffer.active.cursorX, y: window.preview.buffer.active.cursorY }));
        if (frame.name === 'execution-input') executionCursor = cursor;
        else assert.deepEqual(cursor, executionCursor, 'clock and streaming must not flip the input cursor');
      }
      if (frame.name.startsWith('approval')) {
        assert.match(visible, /Review action/);
        assert.match(visible, /risk\s+publish/);
        assert.match(visible, /\[y\] approve once/);
        assert.match(visible, /\[n\] cancel/);
        assert.ok(!visible.includes('TIMER MUST'));
        assert.ok(!visible.includes('Ready input text'));
        if (frame.name === 'approval-40') assert.ok(!visible.split('Review action')[0].includes('echo step'), 'resize must clear the old approval footprint');
      } else {
        assert.match(visible, /bahulam\. code/);
        assert.ok(!visible.includes('[y] approve once'));
      }
      await page.locator('.xterm-screen').screenshot({ path: path.join(artifacts, appearance + '-' + frame.name + '.png') });
    }
    await page.close();
  }
  console.log('16 terminal snapshots verified. Screenshots: ' + artifacts);
} finally {
  await browser.close();
}
