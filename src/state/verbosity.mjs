/**
 * Verbosity modes — Mission Control (PRD-055 §12).
 *
 *   quiet     Folded summary only. Sub-agent inner tools hidden.
 *   default   Folded summary. Sub-agent header shown, inner tools folded.
 *   verbose   Folded summary. Sub-agent inner tools shown.
 *   surgical  Expanded tool details + raw model reasoning.
 *
 * Persisted to `~/.kepler/config.json` under the `verbosity` key so the
 * choice survives across sessions.
 *
 *   import { getVerbosity, setVerbosity, showSubAgentTools, showReasoning } from './verbosity.mjs';
 *
 * No imports from the REPL — this module is pure state + filesystem.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MODES = Object.freeze({
  QUIET:    'quiet',
  DEFAULT:  'default',
  VERBOSE:  'verbose',
  SURGICAL: 'surgical',
});

const VALID = new Set(Object.values(MODES));

const CONFIG_DIR = process.env.KEPLER_HOME || path.join(os.homedir(), '.kepler');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

let _cached = null;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return {}; }
}

function writeConfig(obj) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2));
  } catch { /* best effort */ }
}

/** Read the current mode (falls back to default). */
export function getVerbosity() {
  if (_cached) return _cached;
  const v = readConfig().verbosity;
  _cached = VALID.has(v) ? v : MODES.DEFAULT;
  return _cached;
}

/** Update the persisted mode. Returns the new mode. */
export function setVerbosity(mode) {
  if (!VALID.has(mode)) throw new Error(`Unknown verbosity mode: ${mode}`);
  const cfg = readConfig();
  cfg.verbosity = mode;
  writeConfig(cfg);
  _cached = mode;
  return mode;
}

/** Force-reload from disk (used by tests). */
export function _resetCache() { _cached = null; }

// ── Predicates — let other modules ask "should I render X?" ─────────────

/** Should sub-agent inner tool cards be printed? */
export function showSubAgentTools(mode = getVerbosity()) {
  return mode === MODES.VERBOSE || mode === MODES.SURGICAL;
}

/** Should raw model reasoning be printed? */
export function showReasoning(mode = getVerbosity()) {
  return mode === MODES.SURGICAL;
}

/** Should tool cards default to expanded instead of folded? */
export function defaultExpanded(mode = getVerbosity()) {
  return mode === MODES.SURGICAL;
}

/** Should markdown be rendered? (only `surgical` shows raw, others render) */
export function renderMarkdown(mode = getVerbosity()) {
  return mode !== MODES.SURGICAL;
}

/** Per-mode label for /help and status display. */
export function label(mode = getVerbosity()) {
  switch (mode) {
    case MODES.QUIET:    return 'quiet (compact)';
    case MODES.DEFAULT:  return 'default';
    case MODES.VERBOSE:  return 'verbose (sub-agent tools visible)';
    case MODES.SURGICAL: return 'surgical (everything shown)';
    default:             return String(mode || 'default');
  }
}
