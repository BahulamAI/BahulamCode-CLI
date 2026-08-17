/**
 * Brand icon registry — Mission Control (PRD-055 §4.2).
 *
 * Every CLI surface that prints a tool, phase, or status uses these icons.
 * Each icon has a Unicode form and an ASCII fallback used when the terminal
 * advertises no Unicode support (older Windows shells, locked-down CI).
 *
 *   import { icons, icon } from './icons.mjs';
 *   process.stdout.write(`${icons.subAgent} explore  ${icons.pass} pass`);
 *
 * Or by token (for data-driven tool display):
 *
 *   icon('shell')        // ⚙️
 *   icon('edit_file')    // 🛠️
 */

import { term } from './term.mjs';

// ── Canonical icons ──────────────────────────────────────────────────────

// Note: cannot Object.freeze() this — it is the target of a Proxy whose
// `get` returns a rendered string instead of the raw record, which violates
// the Proxy invariant for frozen targets.
const ICONS = ({
  // Brand
  brand:     { utf: '✦',  ascii: '*'  },
  orbit:     { utf: '◯',  ascii: 'O'  },

  // Tool families
  subAgent:  { utf: '🛰️', ascii: '~>' }, // explore, plan, verify, debug, refactor
  search:    { utf: '🔭', ascii: '?'  }, // search_code, grep, read_file, list_files
  write:     { utf: '🛠️', ascii: '+'  }, // write_file, edit_file, write_project
  shell:     { utf: '⚙️', ascii: '$'  }, // shell, run_tests, validators
  network:   { utf: '🌐', ascii: '@'  }, // WebFetch, MCP network calls

  // State
  pass:      { utf: '✅', ascii: 'OK' },
  warn:      { utf: '⚠️', ascii: '!'  },
  fail:      { utf: '❌', ascii: 'X'  },
  pending:   { utf: '◔',  ascii: '.'  },

  // Workflow
  approve:   { utf: '✔',  ascii: 'Y'  },
  reject:    { utf: '✘',  ascii: 'N'  },
  pause:     { utf: '⏸',  ascii: '||' },
  resume:    { utf: '▶',  ascii: '>'  },
});

// Internal table that the lookup functions consult directly. This stays
// frozen because we never expose it through a Proxy.
const ICON_RECORDS = Object.freeze({ ...ICONS });

// ── Tool → icon mapping ──────────────────────────────────────────────────
// One source of truth so tool display, status bar, and mission report
// agree. Unknown tools fall through to a generic "tool" icon.

const TOOL_ICON = Object.freeze({
  // Sub-agents
  explore:           'subAgent',
  plan:              'subAgent',
  verify:            'subAgent',
  debug:             'subAgent',
  refactor:          'subAgent',
  Agent:             'subAgent',
  agent:             'subAgent',
  task:              'subAgent',
  sub_agent_tools:   'subAgent',

  // Read / search
  read_file:         'search',
  read_files:        'search',
  search_code:       'search',
  search_files:      'search',
  grep:              'search',
  list_files:        'search',
  analyze_code:      'search',
  get_file_info:     'search',
  git_diff:          'search',
  git_status:        'search',
  get_project_overview: 'search',

  // Write / edit
  write_file:        'write',
  write_project:     'write',
  edit_file:         'write',
  delete_file:       'write',

  // Shell / validate
  shell:             'shell',
  run_tests:         'shell',
  validate_build:    'shell',
  validate_file:     'shell',
  validate_structure:'shell',
  lint_check:        'shell',

  // Network
  WebFetch:          'network',
  fetch_url:         'network',
});

// ── Helpers ──────────────────────────────────────────────────────────────

function render(spec) {
  if (!spec) return '';
  return term().unicode ? spec.utf : spec.ascii;
}

/**
 * Resolve an icon by name (e.g. `icons.subAgent`). Always safe — returns
 * the ASCII fallback when the terminal cannot render Unicode.
 *
 * Implemented as a Proxy over a plain object (intentionally not frozen, see
 * the comment above ICONS) so callers can write `icons.pass` directly.
 */
export const icons = new Proxy({}, {
  get(_target, prop) {
    if (typeof prop !== 'string') return undefined;
    return render(ICON_RECORDS[prop]);
  },
  has(_target, prop) {
    return typeof prop === 'string' && prop in ICON_RECORDS;
  },
  ownKeys() {
    return Object.keys(ICON_RECORDS);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop !== 'string' || !(prop in ICON_RECORDS)) return undefined;
    return { configurable: true, enumerable: true, value: render(ICON_RECORDS[prop]) };
  },
});

/**
 * Resolve the icon for a tool name. Falls back to a generic tool icon
 * (`◇`) when the tool is unknown to the registry — this is intentional so
 * unmapped MCP tools and user-defined tools still render with the same
 * visual rhythm.
 */
export function icon(toolName) {
  if (!toolName) return '';
  const raw = String(toolName);
  const key = TOOL_ICON[raw] || TOOL_ICON[raw.toLowerCase()];
  if (key) return render(ICON_RECORDS[key]);

  // MCP tools often arrive as "mcp__server__tool" — strip the prefix and
  // try again before falling back to the generic glyph.
  if (raw.startsWith('mcp')) {
    const cleaned = raw.replace(/^mcp[_-]+/, '').split(/[_-]+/)[0];
    const fallback = TOOL_ICON[cleaned] || TOOL_ICON[cleaned.toLowerCase()];
    if (fallback) return render(ICON_RECORDS[fallback]);
  }

  return term().unicode ? '◇' : '*';
}

/**
 * Tool family (one of: subAgent, search, write, shell, network, other).
 * Used by tier classification and color choice in the tool card renderer.
 */
export function toolFamily(toolName) {
  const raw = String(toolName || '');
  return TOOL_ICON[raw] || TOOL_ICON[raw.toLowerCase()] || 'other';
}

/**
 * Lower-level lookup for callers that want to know whether a name is in
 * the registry (e.g. risk classification fall-throughs).
 */
export function hasIcon(name) {
  return name in ICON_RECORDS;
}
