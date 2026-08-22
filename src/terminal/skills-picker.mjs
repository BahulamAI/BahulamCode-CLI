/**
 * Interactive skills picker — reuses the raw-stdin overlay pattern from
 * repl-ask-form.mjs. Arrow keys move, Enter views the selected SKILL.md,
 * Esc/q closes. Emits nothing when the terminal is not a TTY (falls
 * back to plain-text listing at the call site).
 */

import { c, renderMarkdown, stripAnsi } from './ansi.mjs';
import { fitAnsiLine, writeOverlayFrame, eraseOverlayFrame } from './repl-format.mjs';

function truncate(str, max) {
  const s = String(str || '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * @param {object} opts
 * @param {object|null} opts.rl              readline instance to pause/resume
 * @param {Array<{name,description,scope,source}>} opts.skills
 * @returns {Promise<{action:'view',name:string}|{action:'remove',name:string}|null>}
 */
export async function openSkillsPicker({ rl, skills }) {
  if (!process.stdin.isTTY) return null;
  if (!skills?.length) return null;
  if (rl) rl.pause();

  const rows = skills.map(s => ({
    name: s.name,
    description: s.description || '',
    scope: s.scope,
    source: s.source,
  }));

  return await new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    let cursor = 0;
    let renderedLines = 0;

    const render = () => {
      const cols = Math.max(60, process.stderr.columns || 120);
      const nameWidth = Math.min(24, Math.max(...rows.map(r => r.name.length)));
      const scopeWidth = 8;
      const lines = [];
      lines.push(`  ${c.bold('Installed skills')} ${c.dim(`· ${rows.length} bundle${rows.length === 1 ? '' : 's'}`)}`);
      lines.push('');
      rows.forEach((row, i) => {
        const active = i === cursor;
        const marker = active ? c.brand('▸') : ' ';
        const name = row.name.padEnd(nameWidth).slice(0, nameWidth);
        const scope = row.scope.padEnd(scopeWidth).slice(0, scopeWidth);
        const descBudget = Math.max(20, cols - 6 - nameWidth - scopeWidth - 4);
        const desc = truncate(row.description, descBudget);
        const painted = active
          ? `${c.brand(name)}  ${c.dim(scope)}  ${c.brand(desc)}`
          : `${c.bold(name)}  ${c.dim(scope)}  ${desc}`;
        lines.push(fitAnsiLine(`  ${marker} ${painted}`, cols - 1));
      });
      lines.push('');
      lines.push(fitAnsiLine(
        `  ${c.dim('↑↓ move · Enter view SKILL.md · r remove · Esc close')}`,
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
      if (key === '\x1b' || key === '\x03' || key === 'q') { cleanup(null); return; }
      if (key === '\r' || key === '\n') {
        cleanup({ action: 'view', name: rows[cursor].name });
        return;
      }
      if (key === 'r' || key === 'R') {
        cleanup({ action: 'remove', name: rows[cursor].name });
        return;
      }
      if (key === '\x1b[A' || key === 'k') { cursor = Math.max(0, cursor - 1); render(); return; }
      if (key === '\x1b[B' || key === 'j') { cursor = Math.min(rows.length - 1, cursor + 1); render(); return; }
      if (key === '\x1b[H' || key === 'g') { cursor = 0; render(); return; }
      if (key === '\x1b[F' || key === 'G') { cursor = rows.length - 1; render(); return; }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
  });
}

/**
 * Render a nicely-aligned static list (fallback when no TTY, or for `/skills list`).
 * Returns the printable string; caller writes it to stderr.
 */
export function formatSkillsList(skills) {
  if (!skills?.length) return `  ${c.dim('No skills installed. Try /skills install <git-url>')}\n`;
  const nameWidth = Math.min(28, Math.max(...skills.map(s => s.name.length)));
  const scopeWidth = 8;
  const cols = Math.max(60, process.stderr.columns || 120);
  const descBudget = Math.max(20, cols - 6 - nameWidth - scopeWidth - 4);
  const lines = [`  ${c.bold('Installed skills')} ${c.dim(`· ${skills.length} bundle${skills.length === 1 ? '' : 's'}`)}\n`];
  for (const s of skills) {
    const name = s.name.padEnd(nameWidth).slice(0, nameWidth);
    const scope = String(s.scope || '').padEnd(scopeWidth).slice(0, scopeWidth);
    const desc = truncate(s.description || '', descBudget);
    lines.push(`    ${c.bold(name)}  ${c.dim(scope)}  ${desc}\n`);
  }
  lines.push(`\n  ${c.dim('Open interactively:')} /skills\n`);
  return lines.join('');
}

export { renderMarkdown, stripAnsi };
