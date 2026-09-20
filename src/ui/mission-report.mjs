/**
 * Compact work summary — Read / Change / Verify, followed by command hints.
 * Keeps complete paths, wraps to terminal width, and never invents test totals.
 * renderMissionReport returns ANSI; toMarkdown preserves the full saved report.
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { paint } from './palette.mjs';
import { toolFamily } from './icons.mjs';
import { sectionHeading, glyph } from './chrome.mjs';
import { wrapCode } from './code-layout.mjs';
import { term } from './term.mjs';


// ── Public API ─────────────────────────────────────────────────────────

/**
 * Render the ANSI mission-report block.
 *
 * @param {object} state
 *   task         — string (the user's prompt for this session)
 *   success      — boolean (overall outcome)
 *   filesChanged — string[]
 *   filesRead    — string[]
 *   toolCounts   — { [tool]: count } or array of {tool}
 *   subAgents    — array of { type, costUsd?, tokens? } or { explore:1, plan:1 }
 *   costUsd      — number
 *   durationS    — number
 *   testsPass    — { passed: number, total: number } | null
 *   blockers     — string[] (for failure variant)
 *   nextActions  — string[] (slash-command hints)
 *   cwd          — string (used to derive git repo + author metadata)
 */
export function renderMissionReport(state) {
  const success = state.success !== false;
  const columns = term().columns || 80;
  const lines = ['', sectionHeading(success ? 'Done' : 'Needs attention', {
    detail: 'Work summary', columns, tone: success ? 'brand' : 'danger',
  })];
  const text = (value, painter = paint.text.muted, indent = '  ') => wrapCode(value, painter, { columns, indent });
  if (state.task) lines.push(text(truncate(state.task, 180), paint.text.primary));
  const files = (label, paths) => {
    if (!Array.isArray(paths) || !paths.length) return;
    lines.push(text(label, value => paint.bold(paint.brand.primary(value))));
    for (const file of paths.slice(0, 8)) lines.push(text(file, paint.text.primary, '    '));
    if (paths.length > 8) lines.push(text(glyph('… ', '... ') + (paths.length - 8) + ' more files; /report lists all', paint.text.muted, '    '));
  };
  files('Read', state.filesRead);
  files('Change', state.filesChanged);
  lines.push(text('Verify', value => paint.bold(paint.brand.primary(value))));
  const passed = state.testsPass?.passed, total = state.testsPass?.total;
  if (Number.isFinite(total) && total > 0 && Number.isFinite(passed)) {
    lines.push(text(passed + '/' + total + ' tests pass' + (passed < total ? glyph(' · ', ' / ') + (total - passed) + ' failing' : ''),
      passed === total ? paint.state.success : paint.state.danger, '    '));
  } else if (Number.isFinite(passed)) {
    lines.push(text(passed + ' tests passed; total not reported', paint.text.muted, '    '));
  } else {
    lines.push(text('No test totals reported', paint.text.muted, '    '));
  }
  const tools = stripAnsi(formatToolCounts(state.toolCounts) || '');
  const metrics = [tools ? 'Tools ' + tools : '', state.durationS != null ? 'Time ' + formatDuration(state.durationS) : ''].filter(Boolean);
  if (metrics.length) lines.push(text(metrics.join(glyph(' · ', ' / '))));
  if (state.subAgents) {
    const agents = stripAnsi(formatSubAgents(state.subAgents));
    if (agents) lines.push(text('Agents ' + agents));
  }
  if (!success && state.blockers?.length) {
    lines.push(text('Blocked by', paint.state.danger));
    for (const blocker of state.blockers) lines.push(text(blocker, paint.text.primary, '    '));
  }
  const actions = state.nextActions?.length ? state.nextActions : ['/last', '/report'];
  lines.push(text('Next: ' + actions.join(glyph(' · ', ' / ')), paint.brand.primary));
  lines.push('');
  return lines.join('\n');
}

/**
 * Same content as renderMissionReport, but as plain markdown so callers
 * can persist it under `.bahulam/reports/`.
 */
export function toMarkdown(state) {
  const success = state.success !== false;
  const meta = resolveReportMeta(state);
  const out = [];
  out.push(`# ${success ? 'Done' : 'Held'}${state.task ? ' — ' + state.task : ''}`);
  out.push('');
  out.push('**Repo**: ' + meta.repo);
  out.push('**Author**: ' + meta.author);
  if (Array.isArray(state.filesChanged) && state.filesChanged.length) {
    out.push('**Files**: ' + state.filesChanged.join(', '));
  }
  if (Array.isArray(state.filesRead) && state.filesRead.length) {
    out.push('**Read**: ' + state.filesRead.join(', '));
  }
  const toolSummary = stripAnsi(formatToolCounts(state.toolCounts) || '');
  if (toolSummary) out.push('**Tools**: ' + toolSummary);
  if (state.subAgents) {
    const sub = stripAnsi(formatSubAgents(state.subAgents) || '');
    if (sub) out.push('**Sub-agents**: ' + sub);
  }
  if (state.costUsd != null) out.push('**Cost**: ' + stripAnsi(formatCost(state.costUsd)));
  if (state.durationS != null) out.push('**Time**: ' + formatDuration(state.durationS));
  if (state.testsPass) {
    const { passed = 0, total = 0 } = state.testsPass;
    out.push(Number.isFinite(total) && total > 0
      ? `**Tests**: ${passed}/${total} ${passed === total ? 'pass' : 'pass · ' + (total - passed) + ' failing'}`
      : `**Tests**: ${passed} passed; total not reported`);
  }
  if (!success && Array.isArray(state.blockers) && state.blockers.length) {
    out.push('');
    out.push('## Blocked by');
    for (const b of state.blockers) out.push('- ' + b);
  }
  if (Array.isArray(state.nextActions) && state.nextActions.length) {
    out.push('');
    out.push('**Next**: ' + state.nextActions.join('  '));
  }
  out.push('');
  return out.join('\n');
}

/**
 * Save a markdown copy of the report to `.bahulam/reports/<timestamp>.md`
 * inside the working directory. Returns the absolute path.
 */
export function saveReport(state, { cwd = process.cwd(), timestamp } = {}) {
  const dir = path.join(cwd, '.bahulam', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = timestamp || new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dir, `${stamp}.md`);
  fs.writeFileSync(out, toMarkdown(state));
  return out;
}

// ── Helpers ────────────────────────────────────────────────────────────


function resolveReportMeta(state = {}) {
  const cwd = state.cwd || process.cwd();
  return {
    repo: state.repo || gitValue(cwd, ['remote', 'get-url', 'origin']) ||
      gitValue(cwd, ['rev-parse', '--show-toplevel'], value => path.basename(value)) ||
      path.basename(cwd),
    author: state.author || gitAuthor(cwd) || 'unknown',
  };
}

function gitAuthor(cwd) {
  const name = gitValue(cwd, ['config', '--get', 'user.name']);
  const email = gitValue(cwd, ['config', '--get', 'user.email']);
  if (name && email) return `${name} <${email}>`;
  return name || email || '';
}

function gitValue(cwd, args, transform = value => value) {
  try {
    const value = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value ? transform(value) : '';
  } catch {
    return '';
  }
}


/**
 * Render `read(4)  edit(2)  shell(1)  test(1)` from a counts object/array.
 * Buckets by tool family so the line stays compact.
 */
function formatToolCounts(counts) {
  if (!counts) return '';
  const entries = Array.isArray(counts)
    ? counts
    : Object.entries(counts).map(([tool, n]) => ({ tool, count: n }));
  if (!entries.length) return '';

  const buckets = { read: 0, edit: 0, shell: 0, test: 0, other: 0 };
  for (const { tool, count } of entries) {
    const c = Number(count) || 0;
    if (!c) continue;
    const fam = toolFamily(tool);
    if (tool === 'run_tests' || tool === 'validate_build') buckets.test += c;
    else if (fam === 'write') buckets.edit += c;
    else if (fam === 'shell') buckets.shell += c;
    else if (fam === 'search') buckets.read += c;
    else buckets.other += c;
  }
  const parts = [];
  if (buckets.read)  parts.push(`${paint.brand.data('read')}(${buckets.read})`);
  if (buckets.edit)  parts.push(`${paint.brand.primary('edit')}(${buckets.edit})`);
  if (buckets.shell) parts.push(`${paint.state.warn('shell')}(${buckets.shell})`);
  if (buckets.test)  parts.push(`${paint.state.success('test')}(${buckets.test})`);
  if (buckets.other) parts.push(`${paint.text.muted('tool')}(${buckets.other})`);
  return parts.join(paint.text.dim('  '));
}

function formatSubAgents(subAgents) {
  // Accepts either a flat counts object { explore: 1, plan: 1, savedUsd: 0.08 }
  // or an array of { type, costUsd, tokens }.
  if (!subAgents) return '';
  let counts = {};
  let savedUsd = 0;
  if (Array.isArray(subAgents)) {
    for (const s of subAgents) {
      counts[s.type] = (counts[s.type] || 0) + 1;
      if (typeof s.savedUsd === 'number') savedUsd += s.savedUsd;
    }
  } else {
    counts = { ...subAgents };
    savedUsd = subAgents.savedUsd || 0;
    delete counts.savedUsd;
  }
  const entries = Object.entries(counts).filter(([, n]) => Number(n) > 0);
  if (!entries.length) return '';
  const list = entries.map(([type, n]) => `${paint.brand.data(type)}(${n})`).join(paint.text.dim('  '));
  if (savedUsd > 0) {
    return list + paint.text.dim(` · saved ≈ ${formatCost(savedUsd)}`);
  }
  return list;
}

function formatCost(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(s) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return '0s';
  if (s < 60)  return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}
