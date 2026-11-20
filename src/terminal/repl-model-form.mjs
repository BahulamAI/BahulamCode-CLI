/**
 * Interactive per-role model form for /model (PRD-076 W7).
 *
 * Searchable list picker: Tab / ←→ switches the active role tab, ↑↓ moves
 * through the model list, typing filters incrementally (matches id, label,
 * provider, and the keywords tools / reasoning / free / curated), Enter
 * applies all role selections, Ctrl+R resets every role to backend default,
 * Esc cancels. Same raw-stdin overlay pattern as the resume picker
 * (repl-resume.mjs): pause readline, raw mode on, redraw in place with
 * cursor-up + erase-down, restore on exit.
 */

import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { c } from './ansi.mjs';
import { fitAnsiLine, writeOverlayFrame, eraseOverlayFrame } from './repl-format.mjs';
import {
  cacheProfileLabel,
  formatCategoryBadge,
  isFreeModel,
  isImageGenerationModel,
  modelCategory,
  modelDisplayCategory,
  modelMatchesTextFilter,
} from './model-catalog-display.mjs';

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

export function optionRowsForRole(catalog, row) {
  const available = (catalog || []).filter(m => m?.id);
  const group = String(row?.optionGroup || 'text').toLowerCase();
  if (group === 'image_analysis') {
    return available.filter(m => (
      ['image', 'multimodal'].includes(modelCategory(m))
      && !isImageGenerationModel(m)
    ));
  }
  if (group === 'image_generation') {
    return available.filter(m => modelCategory(m) === 'image' && isImageGenerationModel(m));
  }
  return available.filter(m => ['text', 'chat', 'multimodal'].includes(modelCategory(m)));
}

function capabilityPills(meta) {
  const pills = [];
  if (meta) {
    if (isFreeModel(meta)) pills.push(c.cyan('free'));
    if (meta.supports_tools) pills.push(c.green('tools'));
    if (meta.supports_reasoning) pills.push(c.yellow('reasoning'));
    if (meta.harness_validated) pills.push(c.dim('curated'));
  }
  return pills;
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
export async function pickModelOverridesForm({ rl, roles, catalog, fallbackIds, unavailableNote, input = process.stdin }) {
  if (!input.isTTY) return null;
  if (rl) rl.pause();

  const catalogRows = (catalog || []).filter(m => m?.id);
  const usingFallback = catalogRows.length === 0;
  const byId = new Map(catalogRows.map(m => [m.id, m]));

  // Per-role option id list (DEFAULT_SENTINEL first, current override appended
  // when it is not already in the catalog list so it stays visible).
  const roleModels = new Map();
  const selections = {};
  for (const role of roles) {
    const optionIds = usingFallback
      ? [...new Set((fallbackIds || []).filter(Boolean))]
      : optionRowsForRole(catalogRows, role).map(m => m.id);
    const opts = [DEFAULT_SENTINEL, ...optionIds];
    if (role.current && !opts.includes(role.current)) opts.push(role.current);
    roleModels.set(role.role, opts);
    selections[role.role] = role.current || DEFAULT_SENTINEL;
  }

  const getFilteredList = (roleKey, filter) => {
    const allIds = roleModels.get(roleKey) || [];
    const current = selections[roleKey];
    const out = filter.trim() ? [] : [{ id: DEFAULT_SENTINEL, meta: null, isCurrent: false }];
    if (current && current !== DEFAULT_SENTINEL) {
      const meta = byId.get(current);
      if (!filter || modelMatchesTextFilter(meta || { id: current }, filter)) {
        out.push({ id: current, meta: meta || null, isCurrent: true });
      }
    }
    for (const id of allIds) {
      if (id === DEFAULT_SENTINEL || id === current) continue;
      const meta = byId.get(id);
      if (!filter || modelMatchesTextFilter(meta || { id }, filter)) {
        out.push({ id, meta: meta || null, isCurrent: false });
      }
    }
    return out;
  };

  return await new Promise((resolve) => {
    const wasRaw = input.isRaw;
    let roleIndex = 0;
    let cursor = 0;
    let filter = '';
    let renderedLines = 0;

    const valueLabel = (id, meta) => {
      if (id === DEFAULT_SENTINEL) return c.dim('backend default');
      return c.brand(String(id || ''));
    };

    const valueDescription = (id, meta) => {
      if (id === DEFAULT_SENTINEL) return 'backend default for this role';
      if (!meta) return usingFallback ? 'backend configured model' : 'custom override outside curated catalog';
      const parts = [];
      const label = String(meta.label || '').trim();
      if (label && label !== id) parts.push(c.white(label));
      if (meta.provider) parts.push(c.dim(String(meta.provider)));
      const category = modelDisplayCategory(meta);
      if (category) parts.push(formatCategoryBadge(category));
      const context = formatTokenLimit(meta.context_length, 'ctx');
      if (context) parts.push(c.dim(context));
      const output = formatTokenLimit(meta.max_output, 'out');
      if (output) parts.push(c.dim(output));
      const cache = cacheProfileLabel(meta.cache_profile);
      if (cache) parts.push(c.cyan(cache));
      return parts.join(c.dim(' · '));
    };

    const render = () => {
      const cols = Math.max(60, process.stderr.columns || 120);
      const activeRole = roles[roleIndex];
      const list = getFilteredList(activeRole.role, filter);
      cursor = Math.max(0, Math.min(cursor, list.length - 1));

      const maxRows = Math.max(5, (process.stderr.rows || 30) - 8);
      const startRow = Math.max(0, Math.min(cursor, list.length - maxRows));
      const visible = list.slice(startRow, startRow + maxRows);

      const lines = [];
      const filterSuffix = filter
        ? `  ${c.dim(`[${filter}_`)}${c.dim(']')}`
        : '  ' + c.dim('type to filter · free/curated/reasoning/tools/provider');
      lines.push(`  ${c.bold('Models')} ${c.dim('· session overrides · curated platform catalog')}${filterSuffix}`);
      if (usingFallback) {
        const why = unavailableNote ? ` — ${unavailableNote}` : '';
        lines.push(`  ${c.yellow('!')} ${c.dim(`catalog unavailable${why}; showing this session's backend models`)}`);
      }
      lines.push('');

      // Role tabs.
      const tabs = roles.map((role, i) => {
        const label = String(role.label || role.role);
        const current = selections[role.role] && selections[role.role] !== DEFAULT_SENTINEL;
        const marker = i === roleIndex ? c.brand(`${label} ▸`) : c.dim(label);
        const dot = current ? ` ${c.green('●')}` : '';
        return marker + dot;
      });
      lines.push(`  ${tabs.join(c.dim(' │ '))}`);
      lines.push('');

      if (list.length === 0) {
        lines.push(`  ${c.dim(filter ? `(no models match "${filter}")` : '(no models in catalog for this role)')}`);
      } else {
        for (const item of visible) {
          const marker = item.id === (list[cursor]?.id) ? c.brand('▸') : ' ';
          const label = valueLabel(item.id, item.meta);
          const badge = item.meta ? creditBadge(item.meta) : '';
          const pills = capabilityPills(item.meta);
          const cur = item.isCurrent ? c.green(' (current)') : '';
          const descPart = item.id !== DEFAULT_SENTINEL ? ` ${valueDescription(item.id, item.meta)}` : '';
          const rightBits = [badge ? ` ${c.dim(badge)}` : '', ...pills.map(p => ` ${p}`)].join('');
          const line = `  ${marker} ${label}${cur}${rightBits}${descPart ? c.dim(' — ') + descPart : ''}`;
          lines.push(fitAnsiLine(line, cols - 1));
        }
        if (list.length > maxRows) {
          lines.push(`  ${c.dim(`… ${list.length - maxRows} more (↑↓ scroll) · ${startRow + visible.length}/${list.length}`)}`);
        }
      }

      lines.push('');
      lines.push(fitAnsiLine(
        c.dim('  ↑↓ highlight · type to filter · = select & advance · Tab/←→ role · Enter apply · Ctrl+R defaults · Esc cancel'),
        cols - 1,
      ));
      writeOverlayFrame(renderedLines, lines);
      renderedLines = lines.length;
    };

    const cleanup = (value) => {
      input.unpipe(keys);
      keys.removeListener('keypress', onKey);
      keys.destroy();
      input.setRawMode(wasRaw || false);
      eraseOverlayFrame(renderedLines);
      if (rl) rl.resume();
      resolve(value);
    };

    const keys = new PassThrough();
    emitKeypressEvents(keys);
    const onKey = (_text, { sequence: key }) => {
      if (key === '\x1b' || key === '\x03') { cleanup(null); return; }
      if (key === '\r' || key === '\n') {
        const overrides = {};
        for (const role of roles) {
          const value = selections[role.role];
          if (value && value !== DEFAULT_SENTINEL) overrides[role.role] = value;
        }
        cleanup({ overrides });
        return;
      }
      if (key === '\x12') {
        for (const role of roles) selections[role.role] = DEFAULT_SENTINEL;
        filter = '';
        cursor = 0;
        render();
        return;
      }
      if (key === '=') {
        // Commit the highlighted model to the active role; keep the form open.
        const list = getFilteredList(roles[roleIndex].role, filter);
        const picked = list[Math.min(cursor, list.length - 1)];
        if (picked) {
          selections[roles[roleIndex].role] = picked.id;
          // Advance to the next role for fast multi-role setup.
          roleIndex = (roleIndex + 1) % roles.length;
          filter = '';
          cursor = 0;
        }
        render();
        return;
      }
      if (key === '\t') {
        roleIndex = (roleIndex + 1) % roles.length;
        cursor = 0;
        filter = '';
        render();
        return;
      }
      if (key === '\x1b[A') { cursor = Math.max(0, cursor - 1); render(); return; }
      if (key === '\x1b[B') {
        const list = getFilteredList(roles[roleIndex].role, filter);
        cursor = Math.min(list.length - 1, cursor + 1);
        render();
        return;
      }
      if (key === '\x1b[D') {
        roleIndex = (roleIndex - 1 + roles.length) % roles.length;
        cursor = 0;
        filter = '';
        render();
        return;
      }
      if (key === '\x1b[C') {
        roleIndex = (roleIndex + 1) % roles.length;
        cursor = 0;
        filter = '';
        render();
        return;
      }
      if (key === '\x7f' || key === '\b') {
        filter = filter.slice(0, -1);
        cursor = 0;
        render();
        return;
      }
      // Printable ASCII → incremental filter. Enter key states already handled.
      const printable = /^[\x20-\x7e]$/;
      if (printable.test(key)) {
        filter += key.toLowerCase();
        cursor = 0;
        render();
        return;
      }
    };

    input.setRawMode(true);
    input.resume();
    keys.on('keypress', onKey);
    input.pipe(keys);
    render();
  });
}