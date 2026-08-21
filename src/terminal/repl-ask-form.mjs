/**
 * Interactive ask_user form — rendered when the agent calls the ask_user
 * tool mid-turn to get direction (architecture choice, design decision,
 * ambiguous next step, conflicting instructions, …).
 *
 * Same raw-stdin overlay pattern as repl-model-form.mjs: pause readline,
 * raw mode on, redraw in place, restore on exit. Two input modes:
 *   list — ↑↓ move across options (+ an "Other" row), Enter selects,
 *          Esc declines (agent proceeds with its own judgment)
 *   text — the "Other" row opens a free-text line; Enter submits,
 *          Esc returns to the list
 */

import { c } from './ansi.mjs';
import { fitAnsiLine, writeOverlayFrame, eraseOverlayFrame } from './repl-format.mjs';

const OTHER_SENTINEL = '__other__';

/**
 * @param {object} opts
 * @param {object|null} opts.rl       readline instance to pause/resume
 * @param {string} opts.question      the question to display
 * @param {string[]} opts.options     2-4 option labels from the agent
 * @param {string} [opts.context]     optional one-line context above the question
 * @returns {Promise<{answer: string, source: 'option'|'free_text'}|null>}
 *          null = user declined (Esc) — the agent should proceed on its own
 */
export async function askUserForm({ rl, question, options, context }) {
  if (!process.stdin.isTTY) return null;
  if (rl) rl.pause();

  const optionRows = (options || []).map(o => String(o || '').trim()).filter(Boolean);
  const rows = [...optionRows, OTHER_SENTINEL];

  return await new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    let cursor = 0;
    let renderedLines = 0;
    let mode = 'list';   // 'list' | 'text'
    let freeText = '';

    const render = () => {
      const cols = Math.max(60, process.stderr.columns || 120);
      const lines = [];
      lines.push(`  ${c.bold('Agent question')} ${c.dim('· pick an option or type your own · Esc to let the agent decide')}`);
      if (context) {
        lines.push(fitAnsiLine(`  ${c.dim(String(context))}`, cols - 1));
      }
      lines.push('');
      lines.push(fitAnsiLine(`  ${c.brand('?')} ${c.bold(String(question || ''))}`, cols - 1));
      lines.push('');
      rows.forEach((row, i) => {
        const active = i === cursor;
        const marker = active ? c.brand('▸') : ' ';
        if (row === OTHER_SENTINEL) {
          if (mode === 'text' && active) {
            lines.push(fitAnsiLine(`  ${marker} ${c.brand('Other:')} ${freeText}${c.brand('▎')}`, cols - 1));
          } else {
            lines.push(fitAnsiLine(`  ${marker} ${active ? c.brand('Other — type your own answer') : c.dim('Other — type your own answer')}`, cols - 1));
          }
        } else {
          lines.push(fitAnsiLine(`  ${marker} ${active ? c.brand(row) : row}`, cols - 1));
        }
      });
      lines.push('');
      lines.push(fitAnsiLine(
        mode === 'text'
          ? `  ${c.dim('type your answer · Enter submit · Esc back to options')}`
          : `  ${c.dim('↑↓ move · Enter select · Esc decline (agent decides)')}`,
        cols - 1,
      ));
      writeOverlayFrame(renderedLines, lines);
      renderedLines = lines.length;
    };

    const cleanup = (value) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw || false);
      eraseOverlayFrame(renderedLines);
      if (rl) rl.resume();
      resolve(value);
    };

    const onData = (data) => {
      const key = data.toString('utf8');

      if (mode === 'text') {
        if (key === '\x1b') { mode = 'list'; freeText = ''; render(); return; }
        if (key === '\x03') { cleanup(null); return; }
        if (key === '\r' || key === '\n') {
          const answer = freeText.trim();
          if (answer) { cleanup({ answer, source: 'free_text' }); }
          return;
        }
        if (key === '\x7f' || key === '\b') { freeText = freeText.slice(0, -1); render(); return; }
        // Ignore other escape sequences (arrows etc.) while typing.
        if (key.startsWith('\x1b')) return;
        const printable = [...key].filter(ch => ch >= ' ').join('');
        if (printable) { freeText += printable; render(); }
        return;
      }

      // list mode
      if (key === '\x1b' || key === '\x03' || key === 'q') { cleanup(null); return; }
      if (key === '\r' || key === '\n') {
        const row = rows[cursor];
        if (row === OTHER_SENTINEL) { mode = 'text'; freeText = ''; render(); return; }
        cleanup({ answer: row, source: 'option' });
        return;
      }
      if (key === '\x1b[A') { cursor = Math.max(0, cursor - 1); render(); return; }
      if (key === '\x1b[B') { cursor = Math.min(rows.length - 1, cursor + 1); render(); return; }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
  });
}
