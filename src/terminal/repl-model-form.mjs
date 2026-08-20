/**
 * Interactive per-role model form for /model (PRD-076 W7).
 *
 * ↑↓ picks a role row, ←→ cycles through [backend default] + the curated
 * platform catalog for that role, Enter applies to session overrides,
 * c resets every row to default, Esc cancels. Same raw-stdin overlay
 * pattern as the resume picker (repl-resume.mjs): pause readline, raw
 * mode on, redraw in place with cursor-up + erase-down, restore on exit.
 */

import { c } from './ansi.mjs';
import { fitAnsiLine, writeOverlayFrame, eraseOverlayFrame } from './repl-format.mjs';

const DEFAULT_SENTINEL = '__default__';

function creditBadge(row) {
  const usd = Number(row?.input_cost_usd_per_m);
  if (!Number.isFinite(usd) || usd <= 0) return '';
  const credits = usd * 200; // credits = provider cost × 2 × 100/USD
  return `~${credits < 10 ? credits.toFixed(1) : String(Math.round(credits))} cr/M`;
}

/**
 * @param {object} opts
 * @param {object|null} opts.rl        readline instance to pause/resume
 * @param {Array}  opts.roles          [{ role, label, current, defaultLabel }]
 * @param {Array}  opts.catalog        raw /api/models rows (may be empty)
 * @param {Array}  [opts.fallbackIds]  model ids to cycle when no curated catalog
 * @param {string} [opts.unavailableNote] why the catalog is missing (shown in header)
 * @returns {Promise<{overrides: Record<string,string>}|null>} null = cancelled
 */
export async function pickModelOverridesForm({ rl, roles, catalog, fallbackIds, unavailableNote }) {
  if (!process.stdin.isTTY) return null;
  if (rl) rl.pause();

  const curated = (catalog || []).filter(m => m?.harness_validated && m?.id);
  const usingFallback = curated.length === 0;
  const optionIds = usingFallback
    ? [...new Set((fallbackIds || []).filter(Boolean))]
    : curated.map(m => m.id);
  const baseOptions = [DEFAULT_SENTINEL, ...optionIds];
  const byId = new Map(curated.map(m => [m.id, m]));

  // Per-row option list; a current override that isn't in the curated list
  // is appended so it stays visible and selectable.
  const rows = roles.map(r => {
    let opts = baseOptions;
    let idx = 0;
    if (r.current) {
      const found = baseOptions.indexOf(r.current);
      if (found >= 0) {
        idx = found;
      } else {
        opts = [...baseOptions, r.current];
        idx = opts.length - 1;
      }
    }
    return { ...r, opts, idx };
  });

  return await new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    let cursor = 0;
    let renderedLines = 0;

    const valueLabel = (row) => {
      const value = row.opts[row.idx];
      if (value === DEFAULT_SENTINEL) {
        return c.dim(row.defaultLabel ? `default · ${row.defaultLabel}` : 'backend default');
      }
      const meta = byId.get(value);
      const badge = meta ? creditBadge(meta) : '';
      // Only flag uncurated picks when a curated catalog actually loaded —
      // in fallback mode every option is a known backend model, not a stray.
      const flag = meta || usingFallback ? '' : c.yellow(' (uncurated)');
      return `${c.brand(value)}${badge ? ` ${c.dim(badge)}` : ''}${flag}`;
    };

    const render = () => {
      const cols = Math.max(60, process.stderr.columns || 120);
      const lines = [];
      lines.push(`  ${c.bold('Models')} ${c.dim('· session overrides · curated platform catalog')}`);
      if (usingFallback) {
        const why = unavailableNote ? ` — ${unavailableNote}` : '';
        lines.push(`  ${c.yellow('!')} ${c.dim(`catalog unavailable${why}; showing this session's backend models`)}`);
      }
      lines.push('');
      rows.forEach((row, i) => {
        const marker = i === cursor ? c.brand('▸') : ' ';
        const rawLabel = String(row.label || row.role).padEnd(14, ' ');
        const label = i === cursor ? c.brand(rawLabel) : rawLabel;
        lines.push(fitAnsiLine(`  ${marker} ${label} ${c.dim('‹')} ${valueLabel(row)} ${c.dim('›')}`, cols - 1));
      });
      lines.push('');
      lines.push(fitAnsiLine(`  ${c.dim('↑↓ role · ←→ model · Enter apply · c defaults · Esc cancel')}`, cols - 1));
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
        const overrides = {};
        for (const row of rows) {
          const value = row.opts[row.idx];
          if (value && value !== DEFAULT_SENTINEL) overrides[row.role] = value;
        }
        cleanup({ overrides });
        return;
      }
      if (key === 'c' || key === 'C') { rows.forEach(r => { r.idx = 0; }); render(); return; }
      if (key === '\x1b[A') { cursor = Math.max(0, cursor - 1); render(); return; }
      if (key === '\x1b[B') { cursor = Math.min(rows.length - 1, cursor + 1); render(); return; }
      if (key === '\x1b[D') { const r = rows[cursor]; r.idx = (r.idx - 1 + r.opts.length) % r.opts.length; render(); return; }
      if (key === '\x1b[C') { const r = rows[cursor]; r.idx = (r.idx + 1) % r.opts.length; render(); return; }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
  });
}
