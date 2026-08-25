/**
 * Watch panel — mutable state for the live agent activity tracker.
 *
 * Singleton exported as `watchState`. /watch toggles `active`, and
 * renderEvent hooks push entries during the agent loop. Capped at
 * MAX_ENTRIES to bound memory.
 *
 * Pattern: same as repl-state.mjs — exported mutable singleton.
 */
import { paint } from '../ui/palette.mjs';
import { c } from './ansi.mjs';

const MAX_ENTRIES = 80;

/** @typedef {'spawn'|'activate'|'deactivate'|'handoff'|'tool'|'done'|'error'} EntryKind */

/**
 * @typedef {Object} WatchEntry
 * @property {EntryKind} kind
 * @property {string} id       — unique within the session
 * @property {string} [type]   — agent type (explore, plan, etc.)
 * @property {string} [label]  — display label (query, tool name, etc.)
 * @property {number} [elapsed] — ms since entry was created
 * @property {string} [detail] — extra info (model, tool count, error msg)
 * @property {number} createdAt
 * @property {'active'|'done'|'error'} [status]
 */

export const watchState = {
  /** /watch toggle — when off, no entries are collected */
  active: false,

  /** Ordered list of watch entries, newest last */
  entries: /** @type {WatchEntry[]} */ ([]),

  /** Max visible rows in the panel (terminal rows reserved) */
  maxRows: 6,

  /** Turn-local counter for generating stable ids */
  _seq: 0,

  /** Add a new entry (prepends to front, pops if over MAX_ENTRIES) */
  addEntry(kind, opts = {}) {
    if (!this.active) return;
    const id = opts.id || `w${++this._seq}`;
    const entry = {
      kind,
      id,
      type: opts.type || '',
      label: opts.label || '',
      elapsed: opts.elapsed || 0,
      detail: opts.detail || '',
      createdAt: Date.now(),
      status: opts.status || 'active',
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  },

  /** Update an entry by id (merge). */
  updateEntry(id, patch) {
    if (!this.active) return;
    const entry = this.entries.find(e => e.id === id);
    if (entry) Object.assign(entry, patch);
  },

  /** Remove entries that match a predicate. */
  removeWhere(fn) {
    if (!this.active) return;
    this.entries = this.entries.filter(e => !fn(e));
  },

  clear() {
    this.entries = [];
    this._seq = 0;
  },

  /** Compact printable entries for the panel (newest last). */
  visible(count = this.maxRows) {
    const slice = this.entries.slice(-count);
    return slice.map(e => renderEntryLine(e));
  },
};

/** Format a single WatchEntry to an ANSI line. */
function renderEntryLine(entry) {
  const time = entry.elapsed
    ? c.dim(` ${entry.elapsed < 1000 ? `${entry.elapsed}ms` : `${(entry.elapsed / 1000).toFixed(1)}s`}`)
    : '';

  switch (entry.kind) {
    case 'spawn':
      return `  ${c.green('+')} ${paint.text.dim(entry.type || 'agent')}${entry.label ? ` ${c.dim(entry.label)}` : ''}${time}`;

    case 'activate':
      return `  ${c.cyan('▸')} ${paint.text.dim(entry.type || 'agent')}${entry.label ? ` ${c.dim(entry.label)}` : ''}${time}`;

    case 'deactivate':
      return `  ${c.dim('✗')} ${paint.text.dim(entry.type || 'agent')}${entry.detail ? ` ${c.dim(entry.detail)}` : ''}`;

    case 'handoff':
      return `  ${c.yellow('↳')} ${paint.text.dim(entry.label || 'handoff')}${time}`;

    case 'tool':
      return `  ${paint.text.dim('·')} ${c.dim(entry.type || 'tool')}${entry.label ? ` ${c.dim(entry.label)}` : ''}${time}`;

    case 'done':
      return `  ${c.green('✓')} ${paint.text.dim(entry.type || 'agent')}${entry.detail ? ` ${c.dim(entry.detail)}` : ''}${time}`;

    case 'error':
      return `  ${c.red('✗')} ${paint.text.dim(entry.type || 'agent')}${entry.detail ? ` ${c.dim(entry.detail)}` : ''}`;

    default:
      return `  ${c.dim('·')} ${entry.label || ''}`;
  }
}