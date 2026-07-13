/**
 * Mission report — Mission Control (PRD-055 §11).
 *
 * Replaces the trailing "Done" message at the end of a session with a
 * structured summary:
 *
 *   ───────────────────────────────────────────────────
 *   ✓ done
 *   ───────────────────────────────────────────────────
 *   📂 Files       auth.py, tests/test_auth.py
 *   🛠️ Tools read(4)  edit(2)  shell(1)  test(1) · ⏱ Time 2m 18s
 *   🛰️ Sub-agents  explore(1)  plan(1) · saved ≈ $0.08
 *   ✅ Health      24/24 tests pass
 *   ───────────────────────────────────────────────────
 *
 *   Next:  /commit   /pr   /undo   /report
 *
 * Failure variant uses "held" and lists blockers.
 *
 * `renderMissionReport(state)` returns the ANSI block; `toMarkdown(state)`
 * returns the plain-markdown version saved by `/report`.
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { paint, width as visibleWidth } from './palette.mjs';
import { icons } from './icons.mjs';
import { toolFamily } from './icons.mjs';

const WIDTH = 56;

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
  const lines = [];
  const rule  = paint.text.dim('─'.repeat(WIDTH));

  const statusIcon = success ? paint.state.success('✓') : paint.state.danger('✗');
  const statusText = success ? paint.state.success('done') : paint.state.danger('held');
  const headerTask = state.task ? paint.text.dim(' · ') + paint.text.primary(truncate(state.task, 60)) : '';

  lines.push('');
  lines.push(rule);
  lines.push(`${statusIcon} ${statusText}${headerTask}`);
  lines.push(rule);

  if (Array.isArray(state.filesChanged) && state.filesChanged.length) {
    lines.push(row('📂', 'Files',      formatFiles(state.filesChanged)));
  }
  if (Array.isArray(state.filesRead) && state.filesRead.length) {
    lines.push(row('📖', 'Read',       formatFiles(state.filesRead)));
  }

  const toolSummary = formatToolCounts(state.toolCounts);
  const time = state.durationS != null ? paint.brand.data(formatDuration(state.durationS)) : '';
  const metricSegments = [];
  if (toolSummary) metricSegments.push(`${icons.write} ${paint.text.dim('Tools')} ${toolSummary}`);
  if (time) metricSegments.push(`${paint.text.dim('⏱ Time')} ${time}`);
  if (metricSegments.length) lines.push('  ' + metricSegments.join(paint.text.dim(' · ')));

  if (state.subAgents) {
    const subSummary = formatSubAgents(state.subAgents);
    if (subSummary) lines.push(row(icons.subAgent, 'Sub-agents', subSummary));
  }

  // Test health.
  if (state.testsPass && typeof state.testsPass.total === 'number' && state.testsPass.total > 0) {
    const { passed = 0, total = 0 } = state.testsPass;
    const allGreen = passed === total;
    const icon = allGreen ? paint.state.success('✅') : paint.state.danger('❌');
    const text = allGreen
      ? `${passed}/${total} tests pass`
      : `${passed}/${total} tests pass · ${paint.state.danger((total - passed) + ' failing')}`;
    lines.push(row(icon, allGreen ? 'Health' : 'Tests', text, /*alreadyIcon*/ true));
  }

  lines.push(rule);

  if (!success && Array.isArray(state.blockers) && state.blockers.length) {
    lines.push('');
    lines.push('  ' + paint.bold(paint.state.danger('Blocked by:')));
    for (const b of state.blockers.slice(0, 6)) {
      lines.push('    ' + paint.text.dim('•') + ' ' + paint.text.primary(truncate(b, WIDTH * 2)));
    }
    if (state.blockers.length > 6) {
      lines.push('    ' + paint.text.dim(`… ${state.blockers.length - 6} more`));
    }
  }

  if (Array.isArray(state.nextActions) && state.nextActions.length) {
    lines.push('');
    const next = state.nextActions.map(a => paint.brand.data(a)).join(paint.text.dim('   '));
    lines.push('  ' + paint.text.dim('Next:  ') + next);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Same content as renderMissionReport, but as plain markdown so callers
 * can persist it under `.kepler/reports/`.
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
    out.push(`**Tests**: ${passed}/${total} ${passed === total ? 'pass' : 'pass · ' + (total - passed) + ' failing'}`);
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
 * Save a markdown copy of the report to `.kepler/reports/<timestamp>.md`
 * inside the working directory. Returns the absolute path.
 */
export function saveReport(state, { cwd = process.cwd(), timestamp } = {}) {
  const dir = path.join(cwd, '.kepler', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = timestamp || new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dir, `${stamp}.md`);
  fs.writeFileSync(out, toMarkdown(state));
  return out;
}

// ── Helpers ────────────────────────────────────────────────────────────

function row(icon, label, value, alreadyIcon = false) {
  const i = alreadyIcon ? icon : icon;
  const labelText = paint.text.dim(label.padEnd(11));
  return `  ${i} ${labelText} ${value}`;
}

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

function formatFiles(files) {
  const shortened = files.map(f => paint.text.primary(path.basename(f)));
  if (shortened.length <= 4) return shortened.join(paint.text.dim(', '));
  return shortened.slice(0, 4).join(paint.text.dim(', ')) + paint.text.dim(`, +${files.length - 4} more`);
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
