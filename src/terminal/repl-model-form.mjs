/**
 * Interactive per-role model form for /model (PRD-076 W7).
 *
 * ↑↓ picks a role row, ←→ cycles through [backend default] + the curated
 * platform catalog for that role, Enter applies to session overrides,
 * c resets every row to default, Esc cancels. Same raw-stdin overlay
 * pattern as the resume picker (repl-resume.mjs): pause readline, raw
 * mode on, redraw in place with cursor-up + erase-down, restore on exit.
 */

import { c, stripAnsi } from './ansi.mjs';
import { fitAnsiLine, writeOverlayFrame, eraseOverlayFrame } from './repl-format.mjs';

const DEFAULT_SENTINEL = '__default__';

function creditBadge(row) {
  const usd = Number(row?.input_cost_usd_per_m);
  if (!Number.isFinite(usd) || usd <= 0) return '';
  const credits = usd * 200; // credits = provider cost × 2 × 100/USD
  return `~${credits < 10 ? credits.toFixed(1) : String(Math.round(credits))} cr/M`;
}

function formatTokenLimit(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M ${label}`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K ${label}`;
  return `${Math.round(n)} ${label}`;
}

function formatTiers(value) {
  const tiers = Array.isArray(value) ? value : [];
  const clean = tiers.map(v => String(v || '').trim()).filter(Boolean);
  return clean.length ? clean.join(',') : '';
}

function cacheProfileLabel(value) {
  if (!value) return '';
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed?.type === 'prefix_hash') return 'prefix cache';
  } catch {
    // Fall through to the generic cache hint.
  }
  return 'cache';
}

function modelCategory(model) {
  const category = String(model?.category || 'text').trim().toLowerCase();
  return category === 'chat' ? 'text' : (category || 'text');
}

function isImageGenerationModel(model) {
  const text = `${model?.id || ''} ${model?.label || ''}`.toLowerCase();
  return (
    text.includes('image generation') ||
    text.includes('generate image') ||
    text.includes('gemini-3-pro-image') ||
    text.includes('nano banana')
  );
}

function optionRowsForRole(catalog, row) {
  const curated = (catalog || []).filter(m => m?.harness_validated && m?.id);
  const group = String(row?.optionGroup || 'text').toLowerCase();
  if (group === 'image_analysis') {
    return curated.filter(m => (
      ['image', 'multimodal'].includes(modelCategory(m))
      && !isImageGenerationModel(m)
    ));
  }
  if (group === 'image_generation') {
    return curated.filter(m => modelCategory(m) === 'image' && isImageGenerationModel(m));
  }
  return curated.filter(m => ['text', 'chat'].includes(modelCategory(m)));
}

/**
 * @param {object} opts
 * @param {object|null} opts.rl        readline instance to pause/resume
 * @param {Array}  opts.roles          [{ role, label, description, current, defaultLabel, optionGroup }]
 * @param {Array}  opts.catalog        raw /api/models rows (may be empty)
 * @param {Array}  [opts.fallbackIds]  model ids to cycle when no curated catalog
 * @param {string} [opts.unavailableNote] why the catalog is missing (shown in header)
 * @returns {Promise<{overrides: Record<string,string>}|null>} null = cancelled
 */
export async function pickModelOverridesForm({ rl, roles, catalog, fallbackIds, unavailableNote }) {
  if (!process.stdin.isTTY) return null;
  if (rl) rl.pause();

  const catalogRows = (catalog || []).filter(m => m?.harness_validated && m?.id);
  const usingFallback = catalogRows.length === 0;
  const byId = new Map(catalogRows.map(m => [m.id, m]));

  // Per-row option list; a current override that isn't in the curated list
  // is appended so it stays visible and selectable.
  const rows = roles.map(r => {
    const optionIds = usingFallback
      ? [...new Set((fallbackIds || []).filter(Boolean))]
      : optionRowsForRole(catalogRows, r).map(m => m.id);
    let opts = [DEFAULT_SENTINEL, ...optionIds];
    let idx = 0;
    if (r.current) {
      const found = opts.indexOf(r.current);
      if (found >= 0) {
        idx = found;
      } else {
        opts = [...opts, r.current];
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

    const valueDescription = (row) => {
      const value = row.opts[row.idx];
      if (value === DEFAULT_SENTINEL) {
        return row.description || 'backend default for this role';
      }
      const meta = byId.get(value);
      if (!meta) {
        return usingFallback ? 'backend configured model' : 'custom override outside curated catalog';
      }
      const label = String(meta.label || '').trim();
      const parts = [];
      if (label && label !== value) parts.push(label);
      if (meta.provider) parts.push(String(meta.provider));
      const category = modelCategory(meta);
      if (category) parts.push(category);
      const context = formatTokenLimit(meta.context_length, 'ctx');
      if (context) parts.push(context);
      const output = formatTokenLimit(meta.max_output, 'out');
      if (output) parts.push(output);
      if (meta.supports_tools) parts.push('tools');
      if (meta.supports_reasoning) parts.push('reasoning');
      const cache = cacheProfileLabel(meta.cache_profile);
      if (cache) parts.push(cache);
      const tiers = formatTiers(meta.platform_access_tier);
      if (tiers) parts.push(tiers);
      return parts.join(' · ');
    };

    const render = () => {
      const cols = Math.max(60, process.stderr.columns || 120);
      const labelWidth = Math.min(
        18,
        Math.max(14, ...rows.map(row => stripAnsi(String(row.label || row.role)).length)),
      );
      const lines = [];
      lines.push(`  ${c.bold('Models')} ${c.dim('· session overrides · curated platform catalog')}`);
      if (usingFallback) {
        const why = unavailableNote ? ` — ${unavailableNote}` : '';
        lines.push(`  ${c.yellow('!')} ${c.dim(`catalog unavailable${why}; showing this session's backend models`)}`);
      }
      lines.push('');
      rows.forEach((row, i) => {
        const marker = i === cursor ? c.brand('▸') : ' ';
        const rawLabel = String(row.label || row.role).padEnd(labelWidth, ' ');
        const label = i === cursor ? c.brand(rawLabel) : rawLabel;
        const prefix = `  ${marker} ${label} ${c.dim('‹')} `;
        const suffix = ` ${c.dim('›')}`;
        const descText = valueDescription(row);
        const descMaxCols = Math.max(0, Math.min(72, cols - stripAnsi(prefix + suffix).length - 24));
        const desc = descText && descMaxCols > 12
          ? `  ${c.dim(fitAnsiLine(descText, descMaxCols))}`
          : '';
        const maxValueCols = Math.max(18, cols - stripAnsi(prefix + suffix + desc).length - 1);
        lines.push(fitAnsiLine(`${prefix}${fitAnsiLine(valueLabel(row), maxValueCols)}${suffix}${desc}`, cols - 1));
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
