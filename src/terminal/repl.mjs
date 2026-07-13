/**
 * Kepler REPL — Full Claude-like terminal UX.
 *
 * Pure ANSI. No React. No Ink. No flickering.
 *
 * Features:
 * - Persistent status bar (model, cost, context, elapsed)
 * - Streaming content with live partial updates
 * - Tool execution display (transparent, collapsible)
 * - File diff display with +/- highlighting
 * - Phase/worker progress indicators
 * - Built-in agents (explore, review, architect)
 * - Permission prompts (Y/n/a/t)
 * - Input history & Tab autocomplete
 * - Safety guardrails on all tool execution
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { c, progressBar, spinner, inPlace, renderMarkdown, renderDiff, formatElapsed, formatCost, stripAnsi } from './ansi.mjs';
import { calculateCost, formatCostValue, formatTokens, costToCredits, formatCredits } from '../core/pricing.mjs';
import { TarangStreamClient, EVENT_TYPES } from '../core/stream-client.mjs';
import { JsonlWriter } from '../core/jsonl-writer.mjs';
import { createToolExecutor } from '../core/tool-executor.mjs';
import { buildWorkScope } from '../core/work-scope.mjs';
import { CheckpointManager } from '../core/checkpoints.mjs';
import { HookRunner } from '../config/hook-runner.mjs';
import { runPreflight } from '../onboarding/preflight.mjs';
import { printBanner as printBrandedBanner } from '../ui/banner.mjs';
import { renderMissionReport, saveReport, toMarkdown as missionMarkdown } from '../ui/mission-report.mjs';
import {
  getVerbosity,
  setVerbosity,
  label as verbosityLabel,
  MODES as V_MODES,
} from '../state/verbosity.mjs';
import { persistProjectArtifacts } from '../core/project-artifacts.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from '../core/approval.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';
import { formatMessageWindow, lowWindowStatus, messagesRemaining } from '../core/rate-limit-display.mjs';
import { formatAgentErrorGuidance } from '../core/error-guidance.mjs';
import { BUILTIN_AGENTS, runAgent } from './agents.mjs';
import { SessionManager } from '../core/session-manager.mjs';
import { parseArgs } from '../config/cli-args.mjs';
import { loadEffectivePolicy, formatPolicySourceRows } from '../core/policy-resolver.mjs';
import { loadProjectContext } from '../core/project-context-loader.mjs';
import { buildContextEnvelope } from '../core/context-envelope.mjs';
import { buildResumeHistory, combineResumeSummaries, getRecentSessions, getSessionDetail, getTranscriptProjectRoots } from '../core/local-store.mjs';
import { decideResumeMode, projectedTokensForChoice, formatTokens as formatCtxTokens } from '../core/resume-mode.mjs';
import { appendTask, ensureTaskFiles, loadTaskBoard, moveTask, removeTask, taskCounts, TASK_FILES, updateTask } from '../core/tasks.mjs';
import { applyCompactSummary, localCompactSummary, parseCompactTailCount, prepareCompactHistory } from '../core/compact-history.mjs';
import { toolDisplayLabel, toolDisplaySummary } from './tool-display.mjs';
import { createOrbit } from '../state/orbit.mjs';
import { attachOrbit, unmount as unmountStatusBar } from '../ui/status-bar.mjs';
import { term } from '../ui/term.mjs';
import {
  formatCardHead,
  summarizeResult,
  recordCard,
  lastCard,
  getCard,
  allCards,
} from '../ui/tool-card.mjs';
import { detailFor } from '../ui/tool-details.mjs';
import { paint } from '../ui/palette.mjs';
import {
  renderSubAgentOpen,
  renderSubAgentClose,
  subAgentIndent,
  inSubAgent as inSubAgentBlock,
  resetSubAgents,
} from '../ui/sub-agent.mjs';

import { createRequire } from 'node:module';
const __require = createRequire(import.meta.url);
const VERSION = __require('../../package.json').version;

// ── Safe CWD ──
// If the working directory gets deleted (by a rogue tool call),
// process.cwd() throws ENOENT. Detect and recover.

let _cachedCwd = null;

function safeCwd() {
  try {
    _cachedCwd = process.cwd();
    return _cachedCwd;
  } catch {
    // CWD deleted — try to recover
    const fallback = _cachedCwd || process.env.HOME || '/tmp';
    try {
      process.chdir(fallback);
      process.stderr.write(`  ${c.yellow('Working directory was deleted. Recovered to: ' + fallback)}\n`);
      _cachedCwd = fallback;
      return fallback;
    } catch {
      return process.env.HOME || '/tmp';
    }
  }
}

function messageCountLabel(count) {
  return `${count} ${count === 1 ? 'message' : 'messages'}`;
}

function sessionListTimestamp(s) {
  const value = s.updatedAt || s.startedAt;
  return value ? new Date(value).toLocaleString() : '?';
}

function oneLineInstruction(text, max = 72) {
  const compact = String(text || '(no instruction)').replace(/\s+/g, ' ').trim();
  return compact.length > max ? compact.slice(0, max - 3) + '...' : compact;
}

function fitAnsiLine(text, maxColumns) {
  const max = Math.max(1, Number(maxColumns) || 80);
  const value = String(text || '');
  if (stripAnsi(value).length <= max) return value;

  let visible = 0;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\x1b') {
      const match = value.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    if (visible >= max - 1) break;
    out += value[i];
    visible++;
  }
  return `${out}${c.dim('…')}`;
}

function normalizeResumableSession(s) {
  return {
    sessionId: s.sessionId,
    instruction: s.firstPrompt || s.instruction || '(no instruction)',
    startedAt: s.startTime || s.startedAt || '',
    updatedAt: s.endTime || s.updatedAt || (s.mtime ? new Date(s.mtime).toISOString() : ''),
    project: s.project ? path.basename(s.project) : s.projectName || s.project || '',
    projectPath: s.project || s.projectPath || '',
    transcriptPath: s.filePath || s.transcriptPath || '',
    messageCount: (s.userMessages || 0) + (s.assistantMessages || 0),
    // PRD-068 §5.14.11 derived fields for the picker
    endStatus: s.endStatus || 'unknown',       // 'completed' | 'interrupted' | 'errored' | 'unknown'
    contextTokens: s.contextTokens || 0,       // projected transcript token count
    resumeSummary: s.resumeSummary || null,    // latest resume_summary checkpoint metadata
    costUsd: typeof s.costUsd === 'number' ? s.costUsd : 0,
    partial: !!s.partial,                      // true if the transcript file was partially malformed
    source: 'transcript',
  };
}

async function listResumableSessions() {
  // PRD-068 §5.14.6: JSONL is the single source of truth. The legacy
  // per-project state-only entries never had a transcript, so they can't be
  // replayed — silently dropping them removes a source of "picked a session
  // and got a flat history" surprises.
  const rich = (await getRecentSessions(Infinity)).map(normalizeResumableSession);
  return rich.sort((a, b) => {
    const at = Date.parse(a.updatedAt || a.startedAt || 0) || 0;
    const bt = Date.parse(b.updatedAt || b.startedAt || 0) || 0;
    return bt - at;
  });
}

// ── PRD-068 §5.14 helpers ────────────────────────────────────────────

function endStatusMarker(status) {
  switch (status) {
    case 'completed':   return c.green('✓');
    case 'interrupted': return c.yellow('⚠');
    case 'errored':     return c.red('✗');
    default:            return c.dim('·');
  }
}

function formatSessionCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return c.dim('     ');
  if (n < 0.01) return c.dim('<$0.01');
  return c.dim(`$${n.toFixed(2)}`);
}

function formatResumeCheckpointStatus(session) {
  const marker = session?.resumeSummary;
  if (!marker || !Number(marker.sourceMessageCount)) return '';
  const full = Number(marker.fullMessageCount) || 0;
  const covered = Number(marker.sourceMessageCount) || 0;
  const pct = full > 0 ? ` ${Math.min(100, Math.round((covered / full) * 100))}%` : '';
  return c.dim(` · summarized${pct}`);
}

function formatResumeContextStatus(session) {
  const full = formatCtxTokens(session?.contextTokens || 0);
  const marker = session?.resumeSummary;
  if (!marker || !Number(marker.sourceMessageCount)) {
    return c.dim(`${full.padStart(5, ' ')} ctx`);
  }
  const resumable = formatCtxTokens(projectedTokensForChoice('checkpoint-full', session.contextTokens || 0, {
    resumeSummary: marker,
  }));
  return c.dim(`${resumable.padStart(5, ' ')} resumable · ${full} full`) + formatResumeCheckpointStatus(session);
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const ago = Date.now() - t;
  const m = Math.floor(ago / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

/**
 * PRD-068 §5.14.2 — enriched one-prompt picker.
 * Returns the picked session, `null` on cancel, or `{ action: 'preview', session }`
 * when the user hits P.
 */
async function pickResumableSession(resumable, ctx) {
  const rl = ctx._rl || null;
  if (rl) rl.pause();

  return await new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(null); return; }
    const wasRaw = process.stdin.isRaw;
    const pageSize = Math.min(10, resumable.length);
    const numWidth = String(resumable.length).length;
    let selected = 0;
    let offset = 0;
    let renderedLines = 0;

    const renderMenu = () => {
      if (renderedLines > 0) {
        process.stderr.write(`\x1b[${renderedLines}F\r\x1b[J`);
      }
      if (selected < offset) offset = selected;
      if (selected >= offset + pageSize) offset = selected - pageSize + 1;

      const cols = Math.max(60, process.stderr.columns || 120);
      const lines = [];
      lines.push(`  ${c.bold('Resume a session')}`);
      lines.push('');
      const end = Math.min(offset + pageSize, resumable.length);
      for (let i = offset; i < end; i++) {
        const s = resumable[i];
        const marker = i === selected ? c.brand('▸') : ' ';
        const num = c.dim(`[${String(i + 1).padStart(numWidth, ' ')}]`);
        const project = (s.project || '(unknown)').padEnd(18, ' ').slice(0, 18);
        const ago = formatRelativeTime(s.updatedAt || s.startedAt).padEnd(9, ' ').slice(0, 9);
        const status = endStatusMarker(s.endStatus);
        const msgs = String(s.messageCount).padStart(3, ' ') + ' msgs';
        const ctx = formatResumeContextStatus(s);
        const cost = formatSessionCost(s.costUsd);
        const partial = s.partial ? c.yellow(' ⚠partial') : '';
        const instr = oneLineInstruction(s.instruction, 48);
        lines.push(fitAnsiLine(
          `  ${marker} ${num} ${c.brand(project)} ${c.dim(ago)} ${status} ${c.dim(msgs)} ${ctx} ${cost}${partial}  ${c.dim(instr)}`,
          cols - 1
        ));
      }
      lines.push('');
      lines.push(fitAnsiLine(
        `  ${c.dim(`↑↓ move  ·  Enter resume  ·  P preview  ·  Esc cancel  ·  ${selected + 1}/${resumable.length}`)}`,
        cols - 1
      ));
      process.stderr.write(lines.join('\n') + '\n');
      renderedLines = lines.length;
    };

    const cleanup = (value) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw || false);
      if (rl) rl.resume();
      resolve(value);
    };
    const onData = (data) => {
      const key = data.toString('utf8');
      if (key === '' || key === '') { cleanup(null); return; }
      if (key === '\r' || key === '\n') { cleanup({ action: 'resume', session: resumable[selected] }); return; }
      if (key === 'p' || key === 'P') { cleanup({ action: 'preview', session: resumable[selected] }); return; }
      if (key === '[A') { selected = Math.max(0, selected - 1); renderMenu(); return; }
      if (key === '[B') { selected = Math.min(resumable.length - 1, selected + 1); renderMenu(); return; }
      if (key === '[5~') { selected = Math.max(0, selected - pageSize); renderMenu(); return; }
      if (key === '[6~') { selected = Math.min(resumable.length - 1, selected + pageSize); renderMenu(); return; }
      if (key === '[H' || key === '[1~') { selected = 0; renderMenu(); return; }
      if (key === '[F' || key === '[4~') { selected = resumable.length - 1; renderMenu(); return; }
      if (/^[1-9]$/.test(key)) {
        const index = Number(key) - 1;
        if (index < resumable.length) cleanup({ action: 'resume', session: resumable[index] });
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    renderMenu();
  });
}

/**
 * PRD-068 §5.14.4 — tri-choice overlay shown only when projected ctx > highWatermark.
 * Returns 'full' | 'summary' | 'tail-10' | 'tail-20' | null (cancel).
 */
async function chooseThresholdMode(ctx, decision) {
  if (!process.stdin.isTTY) return decision.defaultChoice;
  const rl = ctx._rl || null;
  if (rl) rl.pause();

  const canFull = decision.mode !== 'no-full-allowed';
  const hasCheckpoint = Boolean(decision.resumeSummary?.sourceMessageCount);
  const firstOption = canFull
    ? { key: 'f', value: 'full', label: 'full transcript', enabled: true }
    : hasCheckpoint
      ? { key: 'f', value: 'checkpoint-full', label: 'checkpointed transcript', enabled: true }
      : { key: 'f', value: 'full', label: 'full transcript', enabled: false };
  const options = [
    firstOption,
    { key: 's', value: 'summary', label: 'summary only',    enabled: true },
    { key: '1', value: 'tail-10', label: 'summary + last 10 turns', enabled: true },
    { key: '2', value: 'tail-20', label: 'summary + last 20 turns', enabled: true },
  ];
  let selected = options.findIndex(o => o.value === decision.defaultChoice && o.enabled);
  if (selected < 0) selected = options.findIndex(o => o.enabled);

  return await new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    let renderedLines = 0;

    const render = () => {
      if (renderedLines > 0) process.stderr.write(`\x1b[${renderedLines}F\r\x1b[J`);
      const cols = Math.max(60, process.stderr.columns || 120);
      const pct = Math.round(decision.usageRatio * 100);
      const projected = formatCtxTokens(decision.projected);
      const win = formatCtxTokens(decision.windowSize);
      const lines = [];
      const rawLabel = hasCheckpoint ? 'Raw full transcript would use' : 'This session would use';
      lines.push(`  ${rawLabel}  ${c.brand(`${projected} / ${win}`)} tokens  (${pct}%)`);
      if (decision.resumeSummary?.sourceMessageCount) {
        const covered = Number(decision.resumeSummary.sourceMessageCount) || 0;
        const full = Number(decision.resumeSummary.fullMessageCount) || 0;
        const suffix = full > 0 ? ` (${covered}/${full} resume messages)` : '';
        lines.push(`  ${c.green('✓')} ${c.dim(`summary checkpoint available${suffix}; summary/tail modes reuse it`)}`);
      }
      lines.push(canFull
        ? `  ${c.yellow('⚠')} ${c.dim('close to the highWatermark — consider a leaner mode:')}`
        : hasCheckpoint
          ? `  ${c.yellow('⚠')} ${c.dim('raw full is over hardCap — checkpoint/tail modes are available:')}`
          : `  ${c.red('⛔')} ${c.dim('over hardCap — full mode disabled:')}`);
      lines.push('');
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        const disabled = !o.enabled;
        const marker = i === selected && !disabled ? c.brand('▸') : ' ';
        const keyTag = c.dim('[') + (disabled ? c.dim(o.key) : c.brand(o.key)) + c.dim(']');
        const proj = formatCtxTokens(projectedTokensForChoice(o.value, decision.projected, {
          resumeSummary: decision.resumeSummary,
        }));
        const label = disabled ? c.dim(o.label) : (i === selected ? c.brand(o.label) : o.label);
        const projCol = c.dim(`${proj.padStart(5, ' ')} ctx`);
        const suffix = disabled ? c.dim('  (over hardCap)') : '';
        lines.push(fitAnsiLine(`  ${marker} ${keyTag} ${label.padEnd(30, ' ')} ${projCol}${suffix}`, cols - 1));
      }
      lines.push('');
      lines.push(fitAnsiLine(`  ${c.dim('↑↓ move  ·  Enter pick  ·  f/s/1/2 shortcut  ·  Esc cancel')}`, cols - 1));
      process.stderr.write(lines.join('\n') + '\n');
      renderedLines = lines.length;
    };

    const cleanup = (value) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw || false);
      if (rl) rl.resume();
      resolve(value);
    };
    const onData = (data) => {
      const key = data.toString('utf8');
      const low = key.toLowerCase();
      if (key === '' || key === '') { cleanup(null); return; }
      if (key === '\r' || key === '\n') { cleanup(options[selected]?.value || null); return; }
      if (key === '[A') {
        // step to previous enabled option
        for (let i = selected - 1; i >= 0; i--) if (options[i].enabled) { selected = i; render(); return; }
        return;
      }
      if (key === '[B') {
        for (let i = selected + 1; i < options.length; i++) if (options[i].enabled) { selected = i; render(); return; }
        return;
      }
      for (let i = 0; i < options.length; i++) {
        if (options[i].key === low && options[i].enabled) { cleanup(options[i].value); return; }
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
  });
}

function resumeModeLabel(mode = 'full') {
  if (mode === 'checkpoint-full') return 'checkpointed transcript';
  if (mode === 'summary') return 'summary only';
  const tailTurns = resumeTailTurnCount(mode);
  if (tailTurns) return `summary + last ${tailTurns} turns`;
  return mode || 'full';
}

/**
 * PRD-068 §5.14.5 — preview overlay for a session/mode. Read-only, `q` to return.
 * If user hits Enter, resolve to the currently-previewed mode so caller can activate.
 */
async function previewResumeSession(session, ctx) {
  if (!process.stdin.isTTY) return null;
  const detail = await getSessionDetail(session.sessionId, { filePath: session.transcriptPath });
  if (!detail) return null;

  const rl = ctx._rl || null;
  if (rl) rl.pause();

  let mode = 'summary';
  const rich = () => buildResumeHistory({ ...detail, recapTailTurns: 8 }, mode);
  let history = rich();

  return await new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    let renderedLines = 0;
    let scrollOffset = 0;

    const render = () => {
      if (renderedLines > 0) process.stderr.write(`\x1b[${renderedLines}F\r\x1b[J`);
      const cols = Math.max(60, process.stderr.columns || 120);
      const rows = Math.max(10, Math.min((process.stderr.rows || 30) - 6, 20));
      const contentLines = (history.summary || '').split('\n');
      // For tail/full modes, also append serialized tail so preview reflects
      // what the agent will actually receive.
      if (mode !== 'summary') {
        contentLines.push('', c.dim('── conversation tail ──'));
        for (const msg of history.agentHistory.slice(1)) {
          contentLines.push(`${msg.role === 'user' ? c.dim('You:') : c.brand('Kepler:')} ${String(msg.content).slice(0, 300)}`);
        }
      }
      const totalLines = contentLines.length;
      const maxOffset = Math.max(0, totalLines - rows);
      if (scrollOffset > maxOffset) scrollOffset = maxOffset;

      const lines = [];
      lines.push(`  ${c.bold('Preview:')} ${c.brand(session.project || '(unknown)')}  ${c.dim('Mode:')} ${c.brand(resumeModeLabel(mode))}  ${c.dim(formatCtxTokens(projectedTokensForChoice(mode, session.contextTokens, { resumeSummary: session.resumeSummary })) + ' ctx')}`);
      lines.push(`  ${c.dim('─'.repeat(60))}`);
      for (let i = scrollOffset; i < Math.min(scrollOffset + rows, totalLines); i++) {
        lines.push(fitAnsiLine(`  ${c.dim(contentLines[i] || '')}`, cols - 1));
      }
      lines.push('');
      lines.push(fitAnsiLine(`  ${c.dim(`↑↓/PgUp/PgDn scroll  ·  f/s/1/2 switch mode  ·  Enter resume this  ·  q back  ·  ${scrollOffset + 1}-${Math.min(scrollOffset + rows, totalLines)}/${totalLines}`)}`, cols - 1));
      process.stderr.write(lines.join('\n') + '\n');
      renderedLines = lines.length;
    };

    const cleanup = (value) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw || false);
      if (rl) rl.resume();
      resolve(value);
    };
    const onData = (data) => {
      const key = data.toString('utf8');
      const low = key.toLowerCase();
      if (key === '' || key === '' || low === 'q') { cleanup({ action: 'back' }); return; }
      if (key === '\r' || key === '\n') { cleanup({ action: 'resume', mode }); return; }
      if (key === '[A') { scrollOffset = Math.max(0, scrollOffset - 1); render(); return; }
      if (key === '[B') { scrollOffset += 1; render(); return; }
      if (key === '[5~') { scrollOffset = Math.max(0, scrollOffset - 10); render(); return; }
      if (key === '[6~') { scrollOffset += 10; render(); return; }
      if (low === 'f') { mode = session.resumeSummary?.sourceMessageCount ? 'checkpoint-full' : 'full'; history = rich(); scrollOffset = 0; render(); return; }
      if (low === 's') { mode = 'summary'; history = rich(); scrollOffset = 0; render(); return; }
      if (low === '1') { mode = 'tail-10'; history = rich(); scrollOffset = 0; render(); return; }
      if (low === '2') { mode = 'tail-20'; history = rich(); scrollOffset = 0; render(); return; }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
  });
}

/**
 * PRD-068 §5.14.7 — explicit cwd confirmation when the picked session lives
 * elsewhere. Returns 'switch' | 'stay' | 'cancel'.
 */
async function confirmCwdSwitch(ctx, savedPath, currentPath) {
  if (!process.stdin.isTTY) return 'switch';
  process.stderr.write(`\n  ${c.dim('This session lives in another repo:')}\n`);
  process.stderr.write(`  ${c.dim('→')} ${c.brand(savedPath)}  ${c.dim(`(current cwd: ${currentPath})`)}\n`);
  process.stderr.write(`  ${c.dim('[Enter]')} switch cwd and resume · ${c.dim('[s]')} stay here and resume anyway · ${c.dim('[n]')} cancel  `);
  const rl = ctx._rl || null;
  if (rl) rl.pause();
  return await new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    const cleanup = (value) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw || false);
      if (rl) rl.resume();
      process.stderr.write('\n');
      resolve(value);
    };
    const onData = (data) => {
      const key = data.toString('utf8').toLowerCase();
      if (key === '' || key === '' || key === 'n') { cleanup('cancel'); return; }
      if (key === '\r' || key === '\n') { cleanup('switch'); return; }
      if (key === 's') { cleanup('stay'); return; }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

// Legacy prompt (kept as a fallback for callers that force compact/full explicitly).
async function chooseResumeHistoryMode(ctx, { defaultMode = 'compact' } = {}) {
  if (!process.stdin.isTTY) return defaultMode;
  process.stderr.write(`\n  ${c.dim('Load history for agent:')} ${c.brand('[c]')} ${c.dim('compact summary')}  ${c.brand('[f]')} ${c.dim('full transcript')}  ${c.dim('(Enter = compact, Esc = cancel):')} `);
  const rl = ctx._rl || null;
  if (rl) rl.pause();
  return await new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    const cleanup = (value) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw || false);
      if (rl) rl.resume();
      process.stderr.write('\n');
      resolve(value);
    };
    const onData = (data) => {
      const key = data.toString('utf8').toLowerCase();
      if (key === '\u0003' || key === '\u001b') { cleanup(null); return; }
      if (key === '\r' || key === '\n' || key === 'c') { cleanup('compact'); return; }
      if (key === 'f') { cleanup('full'); }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

function historyRoleLabel(role) {
  return role === 'user'
    ? c.white('You')
    : role === 'tool'
      ? c.dim('Tool')
      : c.brand('Kepler');
}

function renderHistoryEntries(entries, { limit = 20, maxChars = 120, title = 'Conversation' } = {}) {
  const shown = limit === Infinity ? entries : entries.slice(-limit);
  process.stderr.write(`\n  ${c.bold(title)} (${shown.length}${shown.length === entries.length ? '' : ` of ${entries.length}`} entries)\n`);
  process.stderr.write(`  ${c.gray('─'.repeat(80))}\n`);
  for (const msg of shown) {
    const content = String(msg.content || '').replace(/\s+/g, ' ').trim();
    process.stderr.write(`  ${historyRoleLabel(msg.role)}: ${content.slice(0, maxChars)}${content.length > maxChars ? '...' : ''}\n`);
  }
  process.stderr.write('\n');
}

function renderResumePreview(resumed) {
  const tailTurns = resumeTailTurnCount(resumed.historyMode);
  if (resumed.historyMode === 'compact' || resumed.historyMode === 'summary') {
    if (!resumed.summary) return;
    process.stderr.write(`\n  ${c.bold('Continuity Summary Sent To Agent')}\n`);
    process.stderr.write(`  ${c.gray('─'.repeat(80))}\n`);
    for (const line of resumed.summary.split('\n')) {
      process.stderr.write(`  ${c.dim(line)}\n`);
    }
    process.stderr.write('\n');
    return;
  }

  if (tailTurns && resumed.summary) {
    process.stderr.write(`\n  ${c.bold(`Summary + Last ${tailTurns} Turns`)}\n`);
    process.stderr.write(`  ${c.gray('─'.repeat(80))}\n`);
    for (const line of resumed.summary.split('\n')) {
      process.stderr.write(`  ${c.dim(line)}\n`);
    }
    process.stderr.write('\n');
  }

  if (resumed.replayEvents?.length) {
    const replayStartOrder = replayStartOrderForMode(resumed.history || [], resumed.historyMode);
    const replayEvents = filterResumeReplayEvents(resumed.replayEvents)
      .filter(item => replayStartOrder == null || !Number.isFinite(Number(item.order)) || Number(item.order) >= replayStartOrder);
    const userTurns = (resumed.history || [])
      .filter(m => m.role === 'user')
      .filter(m => replayStartOrder == null || !Number.isFinite(Number(m.order)) || Number(m.order) >= replayStartOrder);
    const replayItems = mergeResumeReplayItems(userTurns, replayEvents);
    const replayTitle = tailTurns ? `Last ${tailTurns} Turns Replay` : 'Replayed Live Session Events';
    process.stderr.write(`\n  ${c.bold(replayTitle)} (${userTurns.length} turns, ${replayEvents.length} events)\n`);
    process.stderr.write(`  ${c.gray('─'.repeat(80))}\n`);
    const sessionSnapshot = JSON.parse(JSON.stringify(session));
    const savedOrbit = _orbit;
    const savedSessionMgr = _sessionMgr;
    _orbit = null;
    _sessionMgr = null;
    try {
      startContentStream();
      for (const item of replayItems) {
        if (item.kind === 'user') {
          flushContent();
          stopSpinner();
          const content = String(item.message.content || '').replace(/\s+/g, ' ').trim();
          process.stderr.write(`\n  ${historyRoleLabel('user')}: ${content}\n`);
          continue;
        }
        renderEvent(item.event.event);
      }
      flushContent();
      stopSpinner();
    } finally {
      _orbit = savedOrbit;
      _sessionMgr = savedSessionMgr;
      for (const key of Object.keys(session)) delete session[key];
      Object.assign(session, sessionSnapshot);
    }
    process.stderr.write('\n');
    return;
  }

  if (resumed.history?.length) {
    renderHistoryEntries(resumed.history, {
      limit: Infinity,
      maxChars: 220,
      title: tailTurns ? `Last ${tailTurns} Turns` : 'Replayed Session History',
    });
  }
}

async function summarizeResumeTranscript({
  auth,
  toolExecutor,
  sessionId,
  projectPath,
  messages,
}) {
  const creds = auth?.loadCredentials?.() || {};
  if (!creds.backendUrl || !creds.token || !Array.isArray(messages) || messages.length === 0) {
    return {
      ok: false,
      source: 'local',
      reason: !creds.backendUrl || !creds.token ? 'missing backend credentials' : 'empty transcript',
    };
  }
  try {
    const client = new TarangStreamClient({
      baseUrl: creds.backendUrl,
      token: creds.token,
      toolExecutor,
    });
    const result = await client.summarizeSession(messages, {
      sessionId,
      projectPath,
      maxTokens: 800,
      timeoutMs: 15000,
    });
    return { ...result, ok: true };
  } catch (err) {
    return {
      ok: false,
      source: 'local',
      reason: err?.message || 'backend summary request failed',
    };
  }
}

async function compactCurrentSession(ctx, rest = '') {
  const tailCount = parseCompactTailCount(rest, 8);
  const preparedLive = prepareCompactHistory({
    agentHistory: session.agentHistory,
    tailCount,
  });
  if (!preparedLive.ok) {
    process.stderr.write(`  ${c.gray(`Nothing to compact — ${preparedLive.reason}.`)}\n`);
    return;
  }

  const progress = startResumeProgress('compact');
  progress.update('preparing compact summary', 18);
  let sourceMessages = preparedLive.sourceMessages;
  let priorSummary = preparedLive.previousSummary || '';
  let previousSourceMessageCount = 0;
  let fullMessageCount = preparedLive.beforeCount;
  let projectPath = safeCwd();
  let sourceFrom = 'live';
  let summaryWarning = '';

  try {
    if (session.id && ctx.jsonlWriter?.flush) {
      progress.update('reading transcript checkpoint', 28);
      await ctx.jsonlWriter.flush();
      const detail = await getSessionDetail(session.id, { filePath: ctx.jsonlWriter.transcriptPath });
      if (detail) {
        const richHistory = buildResumeHistory({ ...detail, recapTailTurns: 8 }, `tail-${tailCount}`);
        if (richHistory.sourceMessages?.length) {
          sourceMessages = richHistory.sourceMessages;
          priorSummary = richHistory.priorSummary || '';
          previousSourceMessageCount = richHistory.summaryCheckpointMessageCount || 0;
          fullMessageCount = richHistory.fullMessageCount || sourceMessages.length;
          projectPath = detail.meta?.project || safeCwd();
          sourceFrom = 'transcript';
        } else if (richHistory.priorSummary) {
          priorSummary = richHistory.priorSummary;
          previousSourceMessageCount = richHistory.summaryCheckpointMessageCount || 0;
          fullMessageCount = richHistory.fullMessageCount || preparedLive.beforeCount;
        }
      }
    }

    if (!sourceMessages.length) {
      progress.stop();
      process.stderr.write(`  ${c.gray('Nothing new to compact.')}\n`);
      return;
    }

    progress.update('summarizing compacted history', 46);
    const backendSummary = await summarizeResumeTranscript({
      auth: ctx.auth,
      toolExecutor: ctx.toolExecutor,
      sessionId: session.id,
      projectPath,
      messages: sourceMessages,
    });
    let summarySource = backendSummary?.summary ? (backendSummary.source || 'backend') : 'local fallback';
    let deltaSummary = backendSummary?.summary || '';
    if (!deltaSummary) {
      summaryWarning = backendSummary?.reason || 'backend summary unavailable';
      deltaSummary = localCompactSummary(sourceMessages);
    }
    const summary = combineResumeSummaries(priorSummary, deltaSummary);

    progress.update('rewriting live context', 74);
    const applied = applyCompactSummary({
      prepared: { ...preparedLive, sourceMessages },
      summary,
      sessionId: session.id,
      cwd: projectPath,
      originalRequest: session.history.find(m => m.role === 'user')?.content || session.lastTask || '',
      previousSourceMessageCount,
    });
    session.agentHistory = applied.agentHistory;
    session.compactSummary = summary;
    session.compactSourceMessageCount = applied.sourceMessageCount;

    if (ctx.jsonlWriter) {
      progress.update('writing summary checkpoint', 88);
      ctx.jsonlWriter.writeKeplerEvent({
        type: 'resume_summary',
        data: {
          session_id: session.id || null,
          mode: 'compact',
          mode_label: '/compact',
          summary,
          summary_source: summarySource,
          summary_warning: summaryWarning || null,
          source: sourceFrom,
          source_message_count: applied.sourceMessageCount,
          previous_source_message_count: previousSourceMessageCount,
          full_message_count: fullMessageCount,
          retained_tail_messages: applied.retainedCount,
          live_before_messages: applied.beforeCount,
          live_after_messages: applied.afterCount,
        },
      });
      await ctx.jsonlWriter.flush?.();
    }

    progress.stop();
    process.stderr.write(
      `  ${c.green('✓')} ${c.dim(`Compacted context: ${applied.beforeCount} → ${applied.afterCount} live messages · retained ${applied.retainedCount} · summary ${summarySource}`)}\n`
    );
    if (summaryWarning) {
      process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`backend summary unavailable — used local summary (${summaryWarning})`)}\n`);
    }
  } catch (err) {
    progress.stop();
    process.stderr.write(`  ${c.red(`Compact failed: ${err?.message || String(err)}`)}\n`);
  }
}

function resumeTailTurnCount(mode = '') {
  const match = String(mode || '').match(/^tail-(\d+)$/);
  if (!match) return null;
  return Math.max(1, Number(match[1]) || 1);
}

function replayStartOrderForMode(history = [], mode = '') {
  const match = String(mode || '').match(/^tail-(\d+)$/);
  if (!match) return null;
  const wanted = Math.max(1, Number(match[1]) || 1);
  let seen = 0;
  const userTurns = history.filter(m => m.role === 'user' && typeof m.content === 'string');
  for (let i = userTurns.length - 1; i >= 0; i--) {
    seen++;
    if (seen >= wanted) {
      const order = Number(userTurns[i].order);
      return Number.isFinite(order) ? order : null;
    }
  }
  return null;
}

function filterResumeReplayEvents(events = []) {
  return events.filter(item => {
    const type = item?.event?.type;
    return !['status', 'session_info', 'complete', 'resumed', 'paused'].includes(type);
  });
}

function mergeResumeReplayItems(userTurns = [], replayEvents = []) {
  const items = [];
  let order = 0;
  for (const message of userTurns) {
    items.push({
      kind: 'user',
      message,
      fileOrder: Number.isFinite(Number(message.order)) ? Number(message.order) : null,
      order: order++,
      time: Date.parse(message.timestamp || '') || 0,
    });
  }
  for (const event of replayEvents) {
    items.push({
      kind: 'event',
      event,
      fileOrder: Number.isFinite(Number(event.order)) ? Number(event.order) : null,
      order: order++,
      time: Date.parse(event.timestamp || '') || 0,
    });
  }
  return items.sort((a, b) => {
    if (a.fileOrder !== null && b.fileOrder !== null && a.fileOrder !== b.fileOrder) {
      return a.fileOrder - b.fileOrder;
    }
    if (a.fileOrder !== null && b.fileOrder === null) return -1;
    if (a.fileOrder === null && b.fileOrder !== null) return 1;
    const at = a.time || Number.MAX_SAFE_INTEGER;
    const bt = b.time || Number.MAX_SAFE_INTEGER;
    return at - bt || a.order - b.order;
  });
}

function resumeProgressBar(percent, width = 12) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((p / 100) * width);
  return `${c.brand('█'.repeat(filled))}${c.gray('░'.repeat(width - filled))} ${String(p).padStart(3)}%`;
}

function startResumeProgress(mode = 'full') {
  let percent = 8;
  let label = `resuming as ${resumeModeLabel(mode)}`;
  let active = true;
  const started = Date.now();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;

  const render = () => {
    if (!active) return;
    const glyph = frames[frame % frames.length];
    frame++;
    inPlace(`  ${c.brand(glyph)} ${c.dim(label)}  ${resumeProgressBar(percent)}  ${c.dim(formatElapsed(started))}`);
  };

  render();
  const timer = setInterval(render, 100);
  return {
    update(nextLabel, nextPercent) {
      if (!active) return;
      if (nextLabel) label = nextLabel;
      if (Number.isFinite(nextPercent)) percent = Math.max(percent, Math.min(98, nextPercent));
      render();
    },
    stop() {
      if (!active) return;
      active = false;
      clearInterval(timer);
      inPlace('');
    },
  };
}

// ── Session State ──

let _sessionMgr = null; // Set in startTerminalRepl, used by renderEvent
let _orbit = null;      // Mission Control orbit state machine; set in startTerminalRepl

const session = {
  id: null,                  // set by backend on first turn via session_info event
  startTime: Date.now(),
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  totalToolCalls: 0,   // across all turns
  turns: 0,
  history: [],         // display transcript (can include reconstructed tool entries)
  agentHistory: [],    // backend continuity payload (compact or full)
  inputHistory: [],    // previous prompts (for Up/Down)
  user: null,          // { github_username, email, role }
  model: null,         // from backend user profile
  blockedOps: 0,       // safety guardrail blocks
  delegations: [],     // agent delegation events: { from, to, time }
  phases: [],          // phase history: { name, time }
  inSubAgent: false,   // true while a sub-agent is running (for indented tool display)
  filesChanged: [],    // files modified this session
  filesRead: [],       // files read this turn
  lastTurnDuration: 0,
  toolCounts: {},      // per-tool histogram (mission report)
  subAgentCounts: {},  // per-sub-agent histogram (mission report)
  savedUsd: 0,         // total sub-agent cost (for "saved by routing")
  lastTask: '',        // most recent user prompt (mission report title)
  lastReasoning: '',   // captured from agent for /why
  budgetUsd: null,     // /budget cap, null = unlimited
  budgetExceeded: false,
  costBreakdown: [],   // per-model usage: [{ model, role, input_tokens, output_tokens, cost }]
  totalCost: 0,        // accumulated session cost (USD)
  costAccurate: false, // true if backend provides per-model breakdown
  isByok: false,       // set from session_info; hides cost + credits when true
  // ── Subscription / credit state (server-authoritative; set from
  //    session_info + complete events) ──
  subscriptionTier: null,        // 'free' | 'cli' | 'pro' | 'pro_plus' | 'enterprise'
  creditsTotal: null,            // remaining credits (included + purchased)
  creditsIncluded: null,         // remaining included credits this period
  creditsPurchased: null,        // remaining purchased credits
  creditsLimit: null,            // per-period included credits limit
  creditsCharged: 0,             // session-cumulative server-reported charges
  creditsLowWarned: false,       // emit the low-balance hint only once per turn
  rateLimit: null,               // rolling message-window state from backend
  msgsLowWarned: false,          // emit the low-window hint only once per turn
};

// ── Commands ──

const COMMANDS = {
  '/help':     'Show commands',
  '/login':    'Sign in via browser',
  '/whoami':   'Show logged-in user',
  '/status':   'Session status & system info',
  '/plan':     'Show plan/tasks',
  '/tasks':    'Show or update project tasks',
  '/stats':    'Progress bars & metrics',
  '/clear':    'Clear conversation',
  '/git':      'Git status',
  '/diff':     'Git diff',
  '/cost':     'Show session cost',
  '/history':  'Show conversation',
  '/settings': 'Show policy/settings',
  '/last':     'Expand last tool output',
  '/expand':   'Expand tool output by index (or "all")',
  '/fold':     'Hide previously expanded tool output',
  '/checkpoint':'List recent file checkpoints',
  '/undo':     'Restore the last file checkpoint',
  '/preflight':'Re-run the onboarding diagnostic',
  '/report':   'Save the mission report as markdown',
  '/why':      'Print the agent reasoning for the last decision',
  '/map':      'Show the registered project tree',
  '/budget':   'Set / clear a hard session cost cap',
  '/quiet':    'Verbosity: hide sub-agent inner tools',
  '/verbose':  'Verbosity: show sub-agent inner tools',
  '/surgical': 'Verbosity: show everything (reasoning, expanded tools)',
  '/compact':  'Compact conversation context',
  '/agents':   'List available agents',
  '/explore':  'Code explorer agent',
  '/review':   'Code review agent',
  '/architect':'Feature architect agent',
  '/safety':   'Show safety guardrail status',
  '/revoke':   'Revoke auto-approvals',
  '/resume':   'Resume a previous session',
  '/sessions': 'List resumable sessions',
  '/logout':   'Sign out and clear credentials',
  '/exit':     'Exit CLI',
};

const HELP_GROUPS = [
  {
    key: 'plan',
    title: 'Plan',
    summary: 'plan and project tasks',
    commands: [
      ['/plan', 'Plan and task overview'],
      ['/plan status', 'Plan owner and task files'],
      ['/plan edit', 'Show editable task/plan paths'],
      ['/tasks', 'List project tasks'],
      ['/tasks add <text>', 'Add backlog task'],
      ['/tasks active|blocked|done <text>', 'Append to a task list'],
    ],
  },
  {
    key: 'status',
    title: 'Status',
    summary: 'session, usage, budget',
    commands: [
      ['/status', 'Session snapshot'],
      ['/status context', 'Loaded .kepler context'],
      ['/status metrics', 'Progress bars and runtime metrics'],
      ['/status cost', 'Credits and message window'],
      ['/status budget <amount|clear>', 'Set or clear session budget'],
    ],
  },
  {
    key: 'history',
    title: 'History',
    summary: 'transcript, reports, undo',
    commands: [
      ['/history', 'Recent transcript'],
      ['/history approvals', 'Approval log'],
      ['/history last', 'Expand last tool output'],
      ['/history expand [n|all]', 'Expand tool output'],
      ['/history checkpoint', 'List checkpoints'],
      ['/history undo', 'Restore latest checkpoint'],
      ['/history report', 'Save mission report'],
    ],
  },
  {
    key: 'settings',
    title: 'Settings',
    summary: 'auth, policy, verbosity',
    commands: [
      ['/settings policy', 'Effective project policy'],
      ['/settings login', 'Sign in'],
      ['/settings logout', 'Sign out'],
      ['/settings whoami', 'Current user'],
      ['/settings quiet|verbose|surgical', 'Verbosity'],
      ['/settings revoke', 'Revoke auto-approvals'],
    ],
  },
  {
    key: 'worktree',
    title: 'Worktree',
    summary: 'git and files',
    commands: [
      ['/git', 'Git status'],
      ['/diff', 'Git diff'],
      ['/map', 'Registered project tree'],
      ['/preflight', 'Onboarding diagnostic'],
      ['/safety', 'Safety guardrail status'],
    ],
  },
  {
    key: 'agents',
    title: 'Agents',
    summary: 'specialist modes',
    commands: [
      ['/agents', 'List built-in agents'],
      ['/explore <instruction>', 'Explore code'],
      ['/review <instruction>', 'Review code'],
      ['/architect <instruction>', 'Design an approach'],
    ],
  },
  {
    key: 'session',
    title: 'Session',
    summary: 'resume and clear',
    commands: [
      ['/sessions', 'List resumable sessions'],
      ['/resume [id]', 'Resume a session'],
      ['/compact', 'Compact conversation context'],
      ['/clear', 'Clear conversation'],
      ['/exit', 'Exit CLI'],
    ],
  },
];

const HELP_GROUP_ALIASES = new Map(
  HELP_GROUPS.flatMap(group => [[group.key, group], [group.title.toLowerCase(), group]])
);

const LEGACY_COMMAND_HINTS = {
  '/stats': '/status metrics',
  '/cost': '/status cost',
  '/budget': '/status budget',
  '/last': '/history last',
  '/expand': '/history expand',
  '/fold': '/history fold',
  '/undo': '/history undo',
  '/checkpoint': '/history checkpoint',
  '/report': '/history report',
  '/login': '/settings login',
  '/logout': '/settings logout',
  '/whoami': '/settings whoami',
  '/quiet': '/settings quiet',
  '/verbose': '/settings verbose',
  '/surgical': '/settings surgical',
  '/revoke': '/settings revoke',
};

const NAMESPACED_COMMANDS = {
  '/status': {
    metrics: '/stats',
    stats: '/stats',
    cost: '/cost',
    credits: '/cost',
    budget: '/budget',
  },
  '/history': {
    last: '/last',
    expand: '/expand',
    fold: '/fold',
    undo: '/undo',
    checkpoint: '/checkpoint',
    checkpoints: '/checkpoint',
    report: '/report',
  },
  '/settings': {
    login: '/login',
    logout: '/logout',
    whoami: '/whoami',
    quiet: '/quiet',
    verbose: '/verbose',
    surgical: '/surgical',
    revoke: '/revoke',
  },
};

function normalizeCommandInput(input) {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const rawCmd = (parts[0] || '').toLowerCase();
  const restParts = parts.slice(1);
  const sub = (restParts[0] || '').toLowerCase();
  const namespaced = NAMESPACED_COMMANDS[rawCmd]?.[sub];
  if (namespaced) {
    return {
      cmd: namespaced,
      rest: restParts.slice(1).join(' '),
      rawCmd,
      aliasTarget: null,
    };
  }
  return {
    cmd: rawCmd,
    rest: restParts.join(' '),
    rawCmd,
    aliasTarget: LEGACY_COMMAND_HINTS[rawCmd] || null,
  };
}

function renderHelp(topic = '') {
  const key = String(topic || '').trim().toLowerCase();
  if (!key) {
    process.stderr.write(`\n  ${c.bold('Kepler Commands')}\n`);
    process.stderr.write(`  ${c.gray('─'.repeat(52))}\n`);
    const top = [
      ['/help', 'Grouped command help'],
      ['/status', 'Session snapshot'],
      ['/plan', 'Task list and plan'],
      ['/tasks', 'Project task files'],
      ['/history', 'Transcript, approvals, undo'],
      ['/settings', 'Policy, auth, verbosity'],
      ['/why', 'Explain last reasoning'],
    ];
    for (const [name, desc] of top) {
      process.stderr.write(`  ${c.brand(name.padEnd(14))} ${desc}\n`);
    }
    process.stderr.write(`\n  ${c.bold('Categories')}\n`);
    for (const group of HELP_GROUPS) {
      process.stderr.write(`  ${c.brand(('/help ' + group.key).padEnd(20))} ${c.dim(group.summary)}\n`);
    }
    process.stderr.write(`\n  ${c.dim('Use /help all for legacy command aliases.')}\n`);
    renderKeyboardHelp();
    return;
  }

  if (key === 'all' || key === 'commands') {
    process.stderr.write(`\n  ${c.bold('All Commands')}\n`);
    process.stderr.write(`  ${c.gray('─'.repeat(52))}\n`);
    for (const [name, desc] of Object.entries(COMMANDS)) {
      const alias = LEGACY_COMMAND_HINTS[name] ? c.dim(`  alias for ${LEGACY_COMMAND_HINTS[name]}`) : '';
      process.stderr.write(`  ${c.brand(name.padEnd(14))} ${desc}${alias}\n`);
    }
    process.stderr.write('\n');
    return;
  }

  const group = HELP_GROUP_ALIASES.get(key);
  if (!group) {
    process.stderr.write(`  ${c.gray(`Unknown help category: ${key}. Use /help.`)}\n`);
    return;
  }

  process.stderr.write(`\n  ${c.bold(group.title)} ${c.dim(group.summary)}\n`);
  process.stderr.write(`  ${c.gray('─'.repeat(52))}\n`);
  for (const [name, desc] of group.commands) {
    process.stderr.write(`  ${c.brand(name.padEnd(30))} ${desc}\n`);
  }
  process.stderr.write('\n');
}

function renderKeyboardHelp() {
  process.stderr.write(`\n  ${c.bold('Keyboard')}\n`);
  process.stderr.write(`  ${c.gray('Ctrl+C')}  exit   ${c.gray('↑↓')}  history   ${c.gray('Tab')}  autocomplete\n`);
  process.stderr.write(`  ${c.gray('d')}       expand last tool   ${c.gray('Space')}  pause/resume   ${c.gray('Esc')}  interrupt\n\n`);
}

function commandCompletions(line) {
  if (line.startsWith('/help ')) {
    const topic = line.slice('/help '.length).toLowerCase();
    const categories = ['all', ...HELP_GROUPS.map(g => g.key)];
    const hits = categories.map(c => `/help ${c}`).filter(cmd => cmd.startsWith(`/help ${topic}`));
    return hits.length ? hits : categories.map(c => `/help ${c}`);
  }
  const top = ['/help', '/status', '/plan', '/tasks', '/history', '/settings', '/why'];
  const namespaced = HELP_GROUPS.flatMap(g => g.commands.map(([name]) => name.split(/\s+/)[0]));
  const all = [...new Set([...top, ...namespaced, ...Object.keys(COMMANDS), '/quit'])].sort();
  const hits = all.filter(cmd => cmd.startsWith(line));
  return hits.length ? hits : all;
}

function slashCommandSuggestions(line, limit = 5) {
  const text = String(line || '').trimStart();
  if (!text.startsWith('/')) return [];
  const partial = text.split(/\s+/)[0] || '/';
  return commandCompletions(partial)
    .filter(cmd => cmd.startsWith('/'))
    .slice(0, limit)
    .map(cmd => ({
      command: cmd,
      description: COMMANDS[cmd] || (cmd === '/quit' ? 'Exit CLI' : ''),
    }));
}

// ── Banner ──

function printBanner(auth) {
  // Delegate the visual block to the branded banner module (PRD-055 §4.3,
  // gradient KEPLER letters in Deep Space Purple → Stellar Magenta → Neon
  // Cyan). The trailing status line stays here because it needs `auth`.
  printBrandedBanner();

  const creds = auth.loadCredentials();
  const env = process.env.TARANG_ENV || 'production';
  const authStatus = creds.token ? c.green('authenticated') : c.red('/login to start');
  process.stderr.write(`  ${c.gray('v' + VERSION)}  ${c.dim(env)}  ${authStatus}\n\n`);
}

// ── Prompt Chrome ──
//
// Design: let the content breathe. The prompt area is a thin contextual
// strip — only shows what changed since last turn. No heavy borders.
//
// Layout after a response:
//
//   <assistant content>
//
//   ✓ 3 tools · 1.2s · $0.02                      ctx 21% · 42k tok
//   ╶─────────────────────────────────────────────────────────────────╴
//   kepler ›
//
// Layout on first prompt (no stats yet):
//
//   ╶─────────────────────────────────────────────────────────────────╴
//   kepler ›

/**
 * Build the contextual status strip — compact, one line.
 * Left side: last-turn summary (tools, time, cost)
 * Right side: session totals (ctx%, tokens)
 */
function computeCacheTotals() {
  let read = 0;
  let write = 0;
  for (const b of session.costBreakdown) {
    read += b.cache_read_tokens || 0;
    write += b.cache_creation_tokens || 0;
  }
  const denom = session.inputTokens + read;
  const hitRate = denom > 0 ? Math.round((read / denom) * 100) : 0;
  return { read, write, hitRate };
}

function buildContextStrip() {
  const totalTokens = session.inputTokens + session.outputTokens;
  const elapsed = formatElapsed(session.startTime);
  const cache = computeCacheTotals();

  const right = [
    c.dim(`${formatTokens(totalTokens)} tok`),
    ...(cache.read > 0 ? [c.dim(`cache ${cache.hitRate}%`)] : []),
    c.dim(elapsed),
  ].join(c.dim(' · '));

  return right;
}

/**
 * Print the prompt separator + prompt label.
 * Minimal horizontal rule with contextual info.
 */
function printPromptBlock() {
  const w = process.stdout.columns || 80;
  const strip = buildContextStrip();
  const stripPlain = stripAnsi(strip);

  // Rule with context strip right-aligned
  const ruleLen = Math.max(0, w - stripPlain.length - 4);
  process.stderr.write(
    c.dim('╶') + c.dim('─'.repeat(ruleLen)) + ' ' + strip + ' ' + c.dim('╴') + '\n'
  );
}

/**
 * Print a turn summary after a response completes.
 * Shows only when there's something meaningful to report.
 */
/**
 * Pull blocker bullet points from the completion payload — used by the
 * failure variant of the mission report.
 */
function extractBlockers(data) {
  const out = [];
  if (data?.error) out.push(String(data.error).slice(0, 160));
  if (Array.isArray(data?.failed_tests)) {
    for (const t of data.failed_tests.slice(0, 6)) {
      if (typeof t === 'string') out.push(t);
      else if (t?.name) out.push(`${t.name}${t.message ? ': ' + t.message : ''}`);
    }
  }
  return out;
}

function printTurnSummary(toolCount, durationS, turnCost) {
  const parts = [];
  if (toolCount > 0) parts.push(`${toolCount} tools`);
  if (durationS) parts.push(`${Number(durationS).toFixed(1)}s`);
  if (parts.length > 0) {
    process.stderr.write(`\n  ${c.green('✓')} ${c.dim(parts.join(' · '))}\n`);
  }
}

function formatMessageChip(rateLimit) {
  const remaining = messagesRemaining(rateLimit);
  if (remaining === Infinity) return 'unlimited messages';
  const limit = Number(rateLimit?.msgs_per_window);
  if (typeof remaining === 'number' && Number.isFinite(limit)) {
    return `${remaining}/${limit} messages`;
  }
  return 'messages';
}

function updateStatusBar() {
  // No-op: status is printed inline via printPromptBlock before each prompt
}

// ── Tool Display Renderer ──

/**
 * Render a tool call as the head of a Mission Control card — icon + label +
 * args. The result arrives later via `renderToolResult` and is appended as a
 * gutter line. Sub-agent calls are indented per session.inSubAgent.
 */
// Deferred-head strategy: we DON'T print the tool head when tool_call fires.
// Instead we buffer it and let renderToolResult emit one combined line
// "head  → outcome · duration\n". A spinner shows what's running in the
// meantime so the user still has feedback during slow tools.
//
// If something else needs to print before the result arrives (a streamed
// content event, a sub-agent open, an error, completion), we flush the
// buffered head as a regular two-line shape first so the interleaving
// content lands below it.
let _pendingHead = null; // { callId, head, indent }
let _lastRenderedBlock = null; // 'tool' | 'content' | null

function flushPendingHead() {
  if (!_pendingHead) return;
  process.stderr.write(`${_pendingHead.head}\n`);
  _lastRenderedBlock = 'tool';
  _pendingHead = null;
}

function clearPendingHead() {
  // Called by interleaving handlers — flush as 2-line shape (because we are
  // about to print something else) and continue.
  flushPendingHead();
}

function renderToolCall(data) {
  const tool = data?.tool || 'unknown';
  const args = data?.args || {};
  const indent = subAgentIndent();
  const callId = data?.call_id || data?._callId || `${tool}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If a previous head is still pending (no result yet), flush it as a
  // regular two-line shape before starting the next one.
  flushPendingHead();

  const head = formatCardHead(tool, args, {
    cwd: safeCwd(),
    columns: process.stderr.columns || 120,
    indent,
  });

  recordCard({ id: callId, tool, args, head, startedAt: Date.now() });
  session.toolCounts[tool] = (session.toolCounts[tool] || 0) + 1;
  _pendingHead = { callId, head, indent };
  // Spinner shows what's running until the result arrives.
  startSpinner(`${tool}…`);
}

/**
 * Render a tool result (success/failure, output snippet).
 */
const _renderedToolResults = new Set();

function formatToolDuration(data) {
  const ms = data?.duration_ms ?? (data?.duration_s != null ? data.duration_s * 1000 : null);
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function renderToolResult(data, eventType = 'tool_result') {
  if (!data) return;
  const indent = subAgentIndent();
  const gutter = `${indent}${paint.text.dim('⎿')}  `;
  const callId = data.call_id || data._callId;
  // Either tool_result or tool_done is allowed to render — whichever wins
  // the race. Subsequent events for the same callId are duplicates.
  if (callId && _renderedToolResults.has(callId)) return;
  if (callId) _renderedToolResults.add(callId);

  const tool = data.tool || data._tool || '';
  const durationMs = data?.duration_ms ?? (data?.duration_s != null ? data.duration_s * 1000 : null);
  recordReadActivity(tool, data.args || {});

  // Update the card buffer so /last and `d` can find it.
  if (callId) recordCard({ id: callId, tool, args: data.args, result: data, durationMs });

  if (data._blocked) session.blockedOps++;

  const { text, tone: t } = summarizeResult(tool, data);
  // Em dash reads more like prose than a system arrow.
  const arrow = paint.text.dim('—');
  const painter = t === 'success' ? paint.state.success
                : t === 'warn'    ? paint.state.warn
                : t === 'danger'  ? paint.state.danger
                                  : paint.text.dim;
  // Skip the duration tail when the tool was effectively instant (<200ms) —
  // "1ms" / "0ms" was noise that hurt the prose feel.
  const duration = (durationMs != null && durationMs < 200) ? '' : formatToolDuration(data);
  const tail = duration ? paint.text.dim(` · ${duration}`) : '';
  const outcome = `${arrow} ${painter(text || 'done')}${tail}`;
  const hasLint = (tool === 'write_file' || tool === 'edit_file') && data.lint;

  // ── Single-line combined emit ──
  // If the head for this call is still buffered (no interleaving content
  // landed), and the combined line fits the terminal width, emit ONE line
  // and skip the gutter entirely.
  if (_pendingHead && _pendingHead.callId === callId && !hasLint && !_pendingHead.head.includes('\n')) {
    const cols = process.stderr.columns || 120;
    const combined = `${_pendingHead.head}  ${outcome}`;
    if (stripAnsi(combined).length <= cols) {
      process.stderr.write(`${combined}\n`);
      _lastRenderedBlock = 'tool';
      _pendingHead = null;
      return;
    }
    // Combined too wide — flush the head as 2-line and fall through.
    flushPendingHead();
  } else if (_pendingHead) {
    // Stale pending head (different callId) — flush it before printing this
    // result's gutter line below.
    flushPendingHead();
  }

  // Two-line shape: gutter under the (already-printed or just-flushed) head.
  process.stderr.write(`${gutter}${outcome}\n`);
  _lastRenderedBlock = 'tool';

  // Lint warnings stay visible alongside writes.
  if (hasLint) {
    process.stderr.write(`${gutter}${paint.state.warn('⚠ ' + String(data.lint).split('\n')[0].slice(0, 80))}\n`);
  }
}

// ── Expand handler — `d`, `/last`, `/expand` ───────────────────────────
//
// All three call into the same renderer so output is consistent across
// keypress and slash-command paths. `expandLast` and `expandIndex` write
// directly to stderr.

function expandLast() {
  const card = lastCard();
  if (!card) {
    process.stderr.write(`  ${paint.text.dim('(no tool to expand yet)')}\n`);
    return;
  }
  process.stderr.write('\n' + detailFor(card) + '\n\n');
}

function expandIndex(idxOrAll) {
  if (idxOrAll === 'all') {
    const cards = allCards();
    if (!cards.length) {
      process.stderr.write(`  ${paint.text.dim('(no tools to expand yet)')}\n`);
      return;
    }
    process.stderr.write('\n');
    for (const c of cards) process.stderr.write(detailFor(c) + '\n');
    process.stderr.write('\n');
    return;
  }
  const card = getCard(idxOrAll);
  if (!card) {
    process.stderr.write(`  ${paint.text.dim('(no card at index ' + idxOrAll + ')')}\n`);
    return;
  }
  process.stderr.write('\n' + detailFor(card) + '\n\n');
}

/**
 * Shorten a file path for display: /Users/sree/Sites/project/src/foo.mjs → src/foo.mjs
 */
function shortPath(p) {
  if (!p) return '';
  const cwd = safeCwd();
  if (p.startsWith(cwd)) return p.slice(cwd.length + 1);
  // Show last 2 segments
  const parts = p.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
}

function rememberReadFile(filePath) {
  const file = shortPath(String(filePath || '').trim());
  if (file && !session.filesRead.includes(file)) session.filesRead.push(file);
}

function recordReadActivity(tool, args = {}) {
  const normalized = String(tool || '').toLowerCase();
  if (normalized === 'read_file' || normalized === 'read') {
    rememberReadFile(args.file_path || args.path);
    return;
  }
  if (normalized === 'read_files') {
    const files = args.file_paths || args.paths || args.files || [];
    for (const file of Array.isArray(files) ? files : []) {
      rememberReadFile(typeof file === 'string' ? file : file?.file_path || file?.path);
    }
  }
}

function thinkingKind(text) {
  return /\b(read|reading|inspect|scan|search|open|trace|look(?:ing)?\s+at)\b/i.test(text)
    ? 'Reading'
    : 'Thinking';
}

// ── Live Spinner ──
// A real animated spinner that ticks on an interval, not just per-call.
// Shows what's happening right now — thinking, tool executing, etc.

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let _spinInterval = null;
let _spinFrame = 0;
let _spinText = '';

function startSpinner(text) {
  _spinText = text;
  _spinFrame = 0;
  if (_spinInterval) return; // already running
  _spinInterval = setInterval(() => {
    if (!_spinText) return;
    const frame = SPIN_FRAMES[_spinFrame % SPIN_FRAMES.length];
    _spinFrame++;
    inPlace(`  ${c.brand(frame)} ${c.dim(_spinText)}`);
  }, 80);
}

function updateSpinner(text) {
  _spinText = text;
}

function stopSpinner() {
  if (_spinInterval) { clearInterval(_spinInterval); _spinInterval = null; }
  _spinText = '';
  inPlace('');
}

// ── Content Streaming Display ──

let _streamBuffer = '';
let _streamedPartialText = '';
let _streamTimer = null;
let _renderedContentThisTurn = false;

function startContentStream() {
  _streamBuffer = '';
  _streamedPartialText = '';
  _renderedToolResults.clear();
  _renderedContentThisTurn = false;
  _lastRenderedBlock = null;
  stopSpinner();
}

function appendContent(text) {
  if (!text) return;
  // Any streamed content between renderToolCall and renderToolResult would
  // scroll the head off "the line above", breaking the in-place collapse.
  clearPendingHead();
  _streamBuffer += text;
  _streamedPartialText += text;

  // Debounce rendering to avoid flicker on rapid partial updates
  if (_streamTimer) clearTimeout(_streamTimer);
  _streamTimer = setTimeout(() => flushContent(), 50);
}

function flushContent() {
  if (_streamTimer) { clearTimeout(_streamTimer); _streamTimer = null; }
  if (!_streamBuffer) return;

  stopSpinner();
  // Any buffered tool head needs to land BEFORE this content so the order
  // is preserved on screen.
  flushPendingHead();
  if (_lastRenderedBlock === 'tool') process.stderr.write('\n');
  const rendered = renderMarkdown(_streamBuffer);
  for (const line of rendered.split('\n')) {
    process.stdout.write(`  ${line}\n`);
  }
  _streamBuffer = '';
  _renderedContentThisTurn = true;
  _lastRenderedBlock = 'content';
}

// ── Event Renderer ──

function renderEvent(event) {
  const { type, data } = event;

  // Push every event into the orbit state machine before rendering so the
  // bottom status bar reflects what is happening this very moment. The orbit
  // module is a no-op when status-bar is not mounted (non-TTY, --headless).
  if (_orbit) _orbit.onEvent(event);

  switch (type) {
    case 'status': {
      const msg = data?.message || '';
      if (!msg || msg === 'Agent started') return;
      startSpinner(msg);
      break;
    }

    case 'thinking': {
      const text = data?.message || data?.text || '';
      if (text && !text.startsWith('Processing')) {
        // Surface substantive thinking text as visible prose so the user can
        // follow the agent's reasoning, not just see a spinner blip. We
        // print at most one line per distinct thought, dim italic.
        if (text.length > 12 && text !== session._lastEmittedThinking) {
          flushPendingHead();
          stopSpinner();
          process.stderr.write(`  ${c.dim(thinkingKind(text) + ' · ')}${c.italic(c.dim(text.slice(0, 200)))}\n`);
          session._lastEmittedThinking = text;
        }
        startSpinner(text.slice(0, 80));
        // Capture reasoning so /why can replay it.
        session.lastReasoning = text;
      }
      break;
    }

    case 'content': {
      let text = data?.text || '';
      if (text) {
        flushContent();
        stopSpinner();
        if (_streamedPartialText && text.startsWith(_streamedPartialText)) {
          text = text.slice(_streamedPartialText.length);
        } else if (_streamedPartialText.includes(text)) {
          text = '';
        }
      }
      if (text) {
        if (_lastRenderedBlock === 'tool') process.stderr.write('\n');
        const rendered = renderMarkdown(text);
        for (const line of rendered.split('\n')) {
          process.stdout.write(`  ${line}\n`);
        }
        _renderedContentThisTurn = true;
        _lastRenderedBlock = 'content';
      }
      break;
    }

    case 'content_partial': {
      const text = data?.text || '';
      if (text) {
        stopSpinner();
        appendContent(text);
      }
      break;
    }

    case 'tool_call':
    case 'tool_request': {
      session.toolCalls++;
      session.totalToolCalls++;
      stopSpinner();
      flushContent();
      renderToolCall(data);
      break;
    }

    // ── HITL: Framework-level approval events ──

    case 'approval_required': {
      stopSpinner();
      flushContent();
      break;
    }

    case 'approval_granted': {
      // Human approvals are rendered by approval.mjs. Auto-read grants are
      // otherwise invisible, so show one dim confirmation before the tool card.
      const scope = data?.grant_scope || data?.scope || '';
      if (scope === 'auto_read') {
        const toolName = data?.tool || data?.tool_name || '';
        const args = data?.args || data?.input || {};
        const summary = toolDisplaySummary(toolName, args);
        const label = toolDisplayLabel(toolName);
        const subject = summary ? `${label} ${summary}` : label;
        process.stderr.write(`  ${c.green('✓')} ${c.dim(`${subject} · auto-approved read`)}\n`);
      }
      break;
    }

    case 'approval_denied': {
      const reason = data?.reason || 'User denied';
      const toolName = data?.tool || '';
      const indent = subAgentIndent();
      process.stderr.write(`${indent}${c.red('✗')} ${c.dim(`Denied ${toolName}: ${reason}`)}\n`);
      break;
    }

    case 'tool_result':
    case 'tool_done': {
      stopSpinner();
      renderToolResult(data, type);
      break;
    }

    case 'plan': {
      stopSpinner();
      flushContent();
      const milestones = data?.milestones || data?.steps || [];
      const title = data?.title || 'Plan';
      process.stderr.write(`\n  ${c.brand('▸')} ${c.bold(title)}\n`);
      for (const [index, milestone] of milestones.entries()) {
        const label = typeof milestone === 'string'
          ? milestone
          : milestone.name || milestone.title || milestone.description || `Step ${index + 1}`;
        const status = typeof milestone === 'object' ? milestone.status : '';
        const marker = status === 'complete' || status === 'completed' ? c.green('✓') : c.dim(`${index + 1}.`);
        process.stderr.write(`     ${marker} ${label}\n`);
      }
      break;
    }

    case 'change': {
      stopSpinner();
      const changeType = data?.type || 'modify';
      const filePath = shortPath(data?.path || '');
      const icon = changeType === 'create' ? c.green('+') :
                   changeType === 'delete' ? c.red('-') : c.yellow('~');
      process.stderr.write(`  ${icon} ${c.dim(filePath)}\n`);
      // Track changed files
      if (filePath && !session.filesChanged.includes(filePath)) {
        session.filesChanged.push(filePath);
      }
      break;
    }

    case 'phase_start':
    case 'phase_update': {
      const phase = data?.phase || data?.stage_name || '';
      if (phase) {
        stopSpinner();
        session.phases.push({ name: phase, time: Date.now() });
        process.stderr.write(`\n  ${c.brand('▸')} ${c.bold(phase)}\n`);
      }
      break;
    }

    case 'phase_summary': {
      const summary = data?.summary || '';
      if (summary) {
        process.stderr.write(`  ${c.dim(summary.slice(0, 120))}\n`);
      }
      break;
    }

    case 'worker_start':
    case 'worker_update': {
      const worker = data?.worker || data?.name || '';
      const status = data?.status || data?.message || 'working';
      if (worker) startSpinner(`${worker}: ${status}`);
      break;
    }

    case 'worker_done': {
      stopSpinner();
      const worker = data?.worker || data?.name || '';
      if (worker) process.stderr.write(`  ${c.green('✓')} ${c.dim(worker)}\n`);
      break;
    }

    case 'delegation': {
      stopSpinner();
      clearPendingHead();
      const from = data?.from || '';
      const to = data?.to || '';
      session.delegations.push({ from, to, time: Date.now() });
      process.stderr.write(`\n  ${c.brand('↳')} ${c.dim(from)} ${c.brand('→')} ${c.bold(to)}`);
      if (data?.instruction) {
        process.stderr.write(`  ${c.dim(data.instruction.slice(0, 50))}`);
      }
      process.stderr.write('\n');
      break;
    }

    // ── Sub-Agent Activity ──

    case 'sub_agent_start': {
      stopSpinner();
      clearPendingHead();
      const agentType = data?.type || 'sub-agent';
      const model = data?.model || '';
      const query = data?.query || '';
      process.stderr.write(renderSubAgentOpen({ type: agentType, model, query }) + '\n');
      session.inSubAgent = inSubAgentBlock(); // kept for legacy readers
      session.subAgentCounts[agentType] = (session.subAgentCounts[agentType] || 0) + 1;
      startSpinner(`${agentType}: working...`);
      break;
    }

    case 'sub_agent_tool': {
      // The regular tool_call event renders the card, indented by the
      // sub-agent stack depth. Just update the spinner text here.
      const agentType = data?.type || 'sub-agent';
      const tool = data?.tool || '';
      if (tool) updateSpinner(`${agentType} → ${tool}`);
      break;
    }

    case 'sub_agent_complete': {
      stopSpinner();
      clearPendingHead();
      const agentType = data?.type || 'sub-agent';
      const usage = data?.usage || {};
      const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      const costUsd = usage.cost_usd ?? usage.total_cost_usd ?? data?.cost_usd ?? null;
      if (typeof costUsd === 'number') session.savedUsd += costUsd;
      const summary = data?.result_summary
        || (data?.result_length > 0 ? `${agentType} returned ${data.result_length} chars` : '');
      process.stderr.write(renderSubAgentClose({
        type: agentType,
        success: data?.success !== false,
        summary,
        costUsd,
        tokens,
        durationS: data?.duration_s,
        toolCalls: data?.tool_calls,
        iterations: data?.iterations,
        error: data?.error,
      }) + '\n\n');
      session.inSubAgent = inSubAgentBlock();
      break;
    }

    case 'plan_created': {
      process.stderr.write(`  ${c.dim('project plan prepared')}\n`);
      break;
    }

    case 'goal_created': {
      process.stderr.write(`  ${c.dim('project goal prepared')}\n`);
      break;
    }

    case 'session_info': {
      if (data?.session_id) {
        session.id = data.session_id;
        // Track in session manager so conversations save to the right file
        if (_sessionMgr) _sessionMgr.setSessionInfo({ session_id: data.session_id });
      }
      if (data?.model) session.model = data.model;
      if (data?.user) session.user = { ...session.user, ...data.user };
      // BYOK users pay their model provider directly; the platform does not
      // charge them credits. Hide cost + credits when this flag is set.
      if (typeof data?.is_byok === 'boolean') session.isByok = data.is_byok;
      // Subscription tier + credit balance — backend is authoritative.
      if (data?.subscription_tier) session.subscriptionTier = data.subscription_tier;
      if (typeof data?.credits_included_limit === 'number') session.creditsLimit = data.credits_included_limit;
      const bal = data?.credits_balance;
      if (bal && typeof bal === 'object') {
        if (typeof bal.total === 'number')     session.creditsTotal = bal.total;
        if (typeof bal.included === 'number')  session.creditsIncluded = bal.included;
        if (typeof bal.purchased === 'number') session.creditsPurchased = bal.purchased;
      }
      if (data?.rate_limit) session.rateLimit = data.rate_limit;
      break;
    }

    case 'error':
      stopSpinner();
      flushContent();
      {
        const guidance = formatAgentErrorGuidance(data || {});
        process.stderr.write(`\n  ${c.red('✗')} ${guidance.title}\n`);
        for (const line of guidance.lines) {
          process.stderr.write(`  ${c.dim(line)}\n`);
        }
        if (guidance.meta.length) {
          process.stderr.write(`  ${c.dim(guidance.meta.join(' · '))}\n`);
        }
      }
      break;

    case 'complete': {
      stopSpinner();
      flushContent();
      resetSubAgents();
      session.inSubAgent = false;

      const summary = data?.summary || '';
      if (summary && !_renderedContentThisTurn) {
        const rendered = renderMarkdown(summary);
        for (const line of rendered.split('\n')) {
          process.stdout.write(`  ${line}\n`);
        }
        _renderedContentThisTurn = true;
      }

      // Update session token counts
      const usage = data?.usage;
      let turnCost = 0;
      if (usage) {
        const inp = usage.total_input_tokens || usage.input_tokens || 0;
        const out = usage.total_output_tokens || usage.output_tokens || 0;
        session.inputTokens += inp;
        session.outputTokens += out;

        // Model-aware cost calculation
        const costResult = calculateCost(usage);
        turnCost = costResult.total;
        session.totalCost += costResult.total;
        session.costAccurate = costResult.accurate;

        // Accumulate per-model breakdown
        for (const entry of costResult.breakdown) {
          const existing = session.costBreakdown.find(b => b.model === entry.model);
          if (existing) {
            existing.input_tokens += entry.input_tokens;
            existing.output_tokens += entry.output_tokens;
            existing.cache_read_tokens += entry.cache_read_tokens || 0;
            existing.cache_creation_tokens += entry.cache_creation_tokens || 0;
            existing.cost += entry.cost;
          } else {
            session.costBreakdown.push({ ...entry });
          }
        }
      }

      session.lastTurnDuration = data?.duration_s || 0;
      if (data?.rate_limit) session.rateLimit = data.rate_limit;

      // ── Server-authoritative credits ──
      // Backend sends usage.credits_charged (this turn) + balance (remaining)
      // in the complete event. CLI uses these instead of the local
      // costToCredits estimate so /status and /cost match the dashboard.
      if (!session.isByok) {
        const msgStatus = lowWindowStatus(session.rateLimit);
        if (!session.msgsLowWarned && msgStatus !== 'ok') {
          const windowLine = formatMessageWindow(session.rateLimit);
          if (msgStatus === 'exhausted') {
            process.stderr.write(`\n  ${c.red('✗')} ${c.dim(`${windowLine}. Wait for the window to reset or upgrade at codekepler.ai/pricing.`)}\n`);
          } else {
            process.stderr.write(`\n  ${c.yellow('⚠')} ${c.dim(`${windowLine}. Message window is running low.`)}\n`);
          }
          session.msgsLowWarned = true;
        }

        const charged = data?.usage?.credits_charged;
        if (typeof charged === 'number') session.creditsCharged += charged;
        const bal = data?.balance;
        if (bal && typeof bal === 'object') {
          if (typeof bal.total === 'number')     session.creditsTotal = bal.total;
          if (typeof bal.included === 'number')  session.creditsIncluded = bal.included;
          if (typeof bal.purchased === 'number') session.creditsPurchased = bal.purchased;
        }
        // Warn once per turn when the remaining credits drop below 20% of the
        // tier's included limit (or below 10 absolute for tiny tiers). Credits
        // stay out of the always-on prompt strip; this warning is the exception.
        if (!session.creditsLowWarned && typeof session.creditsTotal === 'number' && session.creditsLimit) {
          const threshold = Math.max(10, Math.floor(session.creditsLimit * 0.2));
          if (session.creditsTotal <= threshold && session.creditsTotal > 0) {
            process.stderr.write(`\n  ${c.yellow('⚠')} ${c.dim(`${session.creditsTotal} of ${session.creditsLimit} credits remaining on the ${session.subscriptionTier || 'free'} plan. Upgrade or top up at codekepler.ai/pricing.`)}\n`);
            session.creditsLowWarned = true;
          } else if (session.creditsTotal <= 0) {
            process.stderr.write(`\n  ${c.red('✗')} ${c.dim(`Credit balance exhausted on the ${session.subscriptionTier || 'free'} plan. Purchase credits at codekepler.ai/pricing or switch to BYOK.`)}\n`);
            session.creditsLowWarned = true;
          }
        }
      }

      // Sync cumulative session cost into the orbit (status bar shows it).
      if (_orbit) _orbit.onCost(session.totalCost);

      // Compact turn summary
      const tools = data?.tool_calls || session.toolCalls || 0;

      // Mission report — replaces the trailing "Done" when the turn did real
      // work (touched files or invoked tools). Plain chat turns keep the
      // tight printTurnSummary so the report does not feel ceremonial.
      const didRealWork = tools > 0 || session.filesChanged.length > 0;
      if (didRealWork) {
        const successOverall = data?.success !== false;
        const report = renderMissionReport({
          task: session.lastTask,
          success: successOverall,
          filesChanged: session.filesChanged,
          filesRead: session.filesRead,
          toolCounts: session.toolCounts,
          subAgents: { ...session.subAgentCounts, savedUsd: 0 },
          costUsd: null,
          durationS: data?.duration_s,
          testsPass: data?.tests_passed != null
            ? { passed: data.tests_passed, total: data.tests_total || data.tests_passed }
            : null,
          blockers: !successOverall ? (data?.blockers || extractBlockers(data)) : null,
          nextActions: successOverall
            ? ['/commit', '/pr', '/undo', '/report']
            : ['/why', '/undo', '/re-plan'],
          cwd: safeCwd(),
        });
        process.stderr.write(report + '\n');
      } else {
        printTurnSummary(tools, data?.duration_s, turnCost);
      }
      break;
    }

    case 'cancelled':
      stopSpinner();
      flushContent();
      process.stderr.write(`\n  ${c.yellow('⏹')} Cancelled${data?.reason ? ': ' + c.dim(data.reason) : ''}\n`);
      break;

    case 'paused':
      stopSpinner();
      flushPendingHead();
      process.stderr.write(`  ${c.yellow('⏸')} Paused${data?.reason ? '  ' + c.dim(data.reason) : ''}\n`);
      break;

    case 'resumed':
      process.stderr.write(`  ${c.green('▶')} Resumed\n`);
      break;

    default:
      break;
  }
}

// ── Slash Commands ──

function taskListLabel(list) {
  return {
    active: 'Active',
    backlog: 'Backlog',
    blocked: 'Blocked',
    done: 'Done',
  }[list] || list;
}

function firstMeaningfulLines(content, limit = 6) {
  return String(content || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .slice(0, limit);
}

function renderTaskBoard(board, { showDone = false } = {}) {
  const order = showDone
    ? ['active', 'blocked', 'backlog', 'done']
    : ['active', 'blocked', 'backlog'];
  let any = false;
  for (const list of order) {
    const tasks = board.lists[list]?.tasks || [];
    if (!tasks.length) continue;
    any = true;
    process.stderr.write(`\n  ${c.bold(taskListLabel(list))} ${c.dim(board.lists[list].fileName)}\n`);
    for (const task of tasks.slice(0, 12)) {
      const marker = task.checked ? c.green('[x]') : c.dim('[ ]');
      const section = task.section && task.section !== taskListLabel(list) ? c.dim(` · ${task.section}`) : '';
      process.stderr.write(`  ${marker} ${task.text}${section}\n`);
    }
    if (tasks.length > 12) {
      process.stderr.write(`  ${c.dim(`+${tasks.length - 12} more`)}\n`);
    }
  }
  if (!any) {
    process.stderr.write(`  ${c.dim('No project tasks yet. Add one with /tasks add <text>.')}\n`);
  }
}

function renderPlanOverview({ ctx, mode = 'overview' } = {}) {
  const cwd = safeCwd();
  ensureTaskFiles({ cwd });
  const board = loadTaskBoard({ cwd });
  const counts = taskCounts(board);
  const planLines = firstMeaningfulLines(board.plan.content, 8);
  const goalLines = firstMeaningfulLines(board.goal.content, 3);
  const effective = ctx.effectivePolicy || loadEffectivePolicy({ cwd });
  const owner = effective.policy?.planning?.owner || 'auto';

  process.stderr.write(`\n  ${c.bold('Plan')}\n`);
  process.stderr.write(`  ${c.dim('─'.repeat(60))}\n`);
  process.stderr.write(`  ${c.dim('Owner')}       ${c.brand(owner)}\n`);
  process.stderr.write(`  ${c.dim('Tasks')}       ${counts.active} active, ${counts.blocked} blocked, ${counts.backlog} backlog, ${counts.done} done\n`);
  if (mode === 'status') {
    process.stderr.write(`  ${c.dim('Plan file')}   ${board.plan.exists ? board.plan.path : c.dim('(none)')}\n`);
    process.stderr.write(`  ${c.dim('Tasks dir')}   ${board.dir}\n`);
  }

  if (goalLines.length) {
    process.stderr.write(`\n  ${c.bold('Goal')}\n`);
    for (const line of goalLines) process.stderr.write(`  ${line}\n`);
  }
  if (planLines.length) {
    process.stderr.write(`\n  ${c.bold('Current Plan')}\n`);
    for (const line of planLines) process.stderr.write(`  ${line}\n`);
  }

  renderTaskBoard(board, { showDone: mode === 'status' });
  process.stderr.write(`\n  ${c.dim('Update: /tasks add <text> · /tasks move active 1 done · /tasks edit active 1 <text>')}\n\n`);
}

function refreshTaskContext(ctx) {
  try {
    const previous = ctx.latestProjectContext || null;
    ctx.latestProjectContext = loadProjectContext({ cwd: safeCwd(), previous });
    ctx.latestEnvelope = null;
  } catch { /* best effort */ }
}

function handleTasksCommand(rest, ctx) {
  const raw = String(rest || '').trim();
  ensureTaskFiles({ cwd: safeCwd() });
  if (!raw || raw === 'list') {
    const board = loadTaskBoard({ cwd: safeCwd() });
    process.stderr.write(`\n  ${c.bold('Tasks')}\n`);
    process.stderr.write(`  ${c.dim('─'.repeat(60))}\n`);
    renderTaskBoard(board, { showDone: true });
    process.stderr.write(`\n  ${c.dim('Update: /tasks add <text> · /tasks move active 1 done · /tasks edit active 1 <text>')}\n\n`);
    return;
  }

  if (raw === 'help') {
    renderHelp('plan');
    return;
  }

  const parts = raw.split(/\s+/);
  let verb = (parts.shift() || '').toLowerCase();

  if (verb === 'move') {
    try {
      const [from, index, to, ...textParts] = parts;
      const result = moveTask({ cwd: safeCwd(), from, index, to, text: textParts.join(' ') || undefined });
      refreshTaskContext(ctx);
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`moved ${result.from} #${result.index} → ${result.to}`)} ${result.text}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
      process.stderr.write(`  ${c.gray('Usage: /tasks move <active|backlog|blocked|done> <number> <active|backlog|blocked|done> [new text]')}\n`);
    }
    return;
  }

  if (verb === 'edit' || verb === 'rename') {
    try {
      const [list, index, ...textParts] = parts;
      const result = updateTask({ cwd: safeCwd(), list, index, text: textParts.join(' ') });
      refreshTaskContext(ctx);
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`updated ${result.list} #${result.index}`)} ${result.text}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
      process.stderr.write(`  ${c.gray('Usage: /tasks edit <active|backlog|blocked|done> <number> <new text>')}\n`);
    }
    return;
  }

  if (verb === 'remove' || verb === 'rm' || verb === 'delete') {
    try {
      const [list, index] = parts;
      const result = removeTask({ cwd: safeCwd(), list, index });
      refreshTaskContext(ctx);
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`removed ${result.list} #${result.index}`)} ${result.task.text}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
      process.stderr.write(`  ${c.gray('Usage: /tasks remove <active|backlog|blocked|done> <number>')}\n`);
    }
    return;
  }

  if (verb === 'finish' || verb === 'complete' || verb === 'block' || verb === 'unblock') {
    try {
      const [from, index, ...textParts] = parts;
      const to = verb === 'block' ? 'blocked' : verb === 'unblock' ? 'active' : 'done';
      const result = moveTask({ cwd: safeCwd(), from, index, to, text: textParts.join(' ') || undefined });
      refreshTaskContext(ctx);
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`moved ${result.from} #${result.index} → ${result.to}`)} ${result.text}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
      process.stderr.write(`  ${c.gray(`Usage: /tasks ${verb} <active|backlog|blocked|done> <number> [new text]`)}\n`);
    }
    return;
  }

  let list = 'backlog';
  if (verb === 'add' || verb === 'new') {
    const maybeList = (parts[0] || '').toLowerCase();
    if (maybeList in TASK_FILES || ['todo', 'pending', 'current', 'doing', 'complete', 'completed'].includes(maybeList)) {
      list = parts.shift();
    }
  } else if (verb in TASK_FILES || ['todo', 'pending', 'current', 'doing', 'complete', 'completed'].includes(verb)) {
    list = verb;
  } else {
    parts.unshift(verb);
    verb = 'add';
  }

  try {
    const result = appendTask({ cwd: safeCwd(), list, text: parts.join(' ') });
    refreshTaskContext(ctx);
    process.stderr.write(`  ${c.green('✓')} ${c.dim(`added to ${result.list}`)} ${result.text}\n`);
  } catch (err) {
    process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
  }
}

async function handleCommand(input, ctx) {
  const { cmd, rest, aliasTarget } = normalizeCommandInput(input);
  if (aliasTarget) {
    process.stderr.write(`  ${c.dim(`Legacy alias: use ${aliasTarget}`)}\n`);
  }

  switch (cmd) {
    case '/help': {
      renderHelp(rest);
      return;
    }

    case '/plan': {
      const mode = rest.trim().toLowerCase();
      if (mode === 'help') {
        renderHelp('plan');
        return;
      }
      if (mode === 'edit') {
        ensureTaskFiles({ cwd: safeCwd() });
        const board = loadTaskBoard({ cwd: safeCwd() });
        process.stderr.write(`\n  ${c.bold('Editable Plan Files')}\n`);
        process.stderr.write(`  ${c.dim('Plan')}      ${board.plan.path}\n`);
        process.stderr.write(`  ${c.dim('Active')}    ${board.lists.active.path}\n`);
        process.stderr.write(`  ${c.dim('Backlog')}   ${board.lists.backlog.path}\n`);
        process.stderr.write(`  ${c.dim('Blocked')}   ${board.lists.blocked.path}\n`);
        process.stderr.write(`  ${c.dim('Done')}      ${board.lists.done.path}\n\n`);
        return;
      }
      renderPlanOverview({ ctx, mode: mode === 'status' ? 'status' : 'overview' });
      return;
    }

    case '/tasks':
      handleTasksCommand(rest, ctx);
      return;

    case '/history': {
      if (rest.trim() === 'fold') {
        process.stderr.write(`  ${c.gray('Output is folded by default — there is nothing to hide. Use /history last or d to expand.')}\n`);
        return;
      }
      if (rest.trim() === 'help') {
        renderHelp('history');
        return;
      }
      if (rest.trim() === 'approvals') {
        const entries = ctx.approval?.approvalLog?.readRecent?.(20) || [];
        if (!entries.length) {
          process.stderr.write(`  ${c.gray('No approval log entries yet.')}\n`);
          return;
        }
        process.stderr.write(`\n  ${c.bold('Approval History')}\n`);
        process.stderr.write(`  ${c.gray('─'.repeat(80))}\n`);
        for (const e of entries) {
          const when = e.ts ? String(e.ts).slice(0, 19).replace('T', ' ') : '';
          const decision = e.decision?.includes('reject') || e.decision?.includes('deny') ? c.red(e.decision) : c.green(e.decision);
          process.stderr.write(`  ${c.dim(when)}  ${decision}  ${c.brand(e.tool || '?')}  ${c.dim(e.scope || 'once')}  ${c.dim(e.args || '')}\n`);
        }
        process.stderr.write('\n');
        return;
      }
      if (session.history.length === 0) { process.stderr.write(`  ${c.gray('No conversation yet.')}\n`); return; }
      renderHistoryEntries(session.history, { limit: 20, maxChars: 120 });
      return;
    }

    case '/login':
      process.stderr.write(`${c.brand('Starting login flow...')}\n`);
      try {
        await ctx.auth.login();
        process.stderr.write(`${c.green('✓ Login successful!')}\n`);
        await fetchUser(ctx);
      } catch (err) {
        process.stderr.write(`${c.red('✗ Login failed: ' + err.message)}\n`);
      }
      return;

    case '/whoami': {
      if (!session.user) await fetchUser(ctx);
      if (session.user) {
        process.stderr.write(`\n  ${c.green('✓')} ${session.user.github_username}\n`);
        process.stderr.write(`  ${c.gray('Email:')}   ${session.user.email || 'n/a'}\n`);
        process.stderr.write(`  ${c.gray('User ID:')} ${session.user.id}\n`);
        process.stderr.write(`  ${c.gray('Role:')}    ${session.user.role || 'user'}\n\n`);
      } else {
        process.stderr.write(`  ${c.red('Not logged in. Run /login.')}\n`);
      }
      return;
    }

    case '/status': {
      if (rest.trim() === 'help') {
        renderHelp('status');
        return;
      }
      if (rest.trim() === 'context') {
        const current = ctx.latestProjectContext || loadProjectContext({ cwd: safeCwd() });
        const envelope = ctx.latestEnvelope || buildContextEnvelope({
          cwd: safeCwd(),
          effectivePolicy: ctx.effectivePolicy,
          projectContext: current,
          projectResources: ctx.toolExecutor?.getProjectResources?.() || [],
          agentContext: ctx.toolExecutor?.getAgentContext?.() || {},
        });
        process.stderr.write(`\n  ${c.bold('Context')}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(60))}\n`);
        const loaded = current.loaded || [];
        if (!loaded.length) {
          process.stderr.write(`  ${c.dim('No .kepler context files loaded yet.')}\n`);
        } else {
          for (const file of loaded) {
            const changed = file.changed ? ` ${c.yellow('updated')}` : '';
            process.stderr.write(`  ${c.brand(file.label.padEnd(18))} ${c.dim(file.hash)} ${c.dim(file.path)}${changed}\n`);
          }
        }
        process.stderr.write(`\n  ${c.bold('Command Context')}\n`);
        process.stderr.write(`  ${c.dim('Active')}       ${envelope.command_context.active_command || c.dim('(none)')}\n`);
        process.stderr.write(`  ${c.dim('Source')}       ${envelope.command_context.source}\n`);
        process.stderr.write(`  ${c.dim('Timeout')}      ${envelope.command_context.runtime_limits.command_timeout_seconds}s command, ${envelope.command_context.runtime_limits.tool_timeout_seconds}s tool\n`);
        process.stderr.write(`  ${c.dim('Plan owner')}   ${envelope.effective_options.plan_owner}\n`);
        process.stderr.write(`  ${c.dim('HITL scope')}   ${envelope.effective_options.hitl_default_scope} ${c.dim(`(reask ${envelope.effective_options.reask_after_minutes}m)`)}\n`);
        if (envelope.available_skills.length) {
          process.stderr.write(`\n  ${c.bold('Skills')}\n`);
          for (const skill of envelope.available_skills.slice(0, 12)) {
            process.stderr.write(`  ${c.brand(skill.name)} ${c.dim(skill.scope)} ${c.dim(skill.description || '')}\n`);
          }
        }
        process.stderr.write('\n');
        return;
      }

      const creds = ctx.auth.loadCredentials();
      const env = process.env.TARANG_ENV || 'production';
      const os = await import('node:os');
      const mem = process.memoryUsage();
      const approvalSummary = ctx.approval.getSummary();

      process.stderr.write(`\n  ${c.bold('Session')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
      process.stderr.write(`  ${c.dim('ID')}           ${session.id || c.dim('(not assigned yet)')}\n`);
      process.stderr.write(`  ${c.dim('User')}         ${session.user?.github_username || '—'}\n`);
      process.stderr.write(`  ${c.dim('Model')}        ${session.model || 'backend default'}\n`);
      if (env === 'local') {
        process.stderr.write(`  ${c.dim('Backend')}      ${creds.backendUrl}\n`);
      }
      process.stderr.write(`  ${c.dim('Env')}          ${env}\n`);
      process.stderr.write(`  ${c.dim('Turns')}        ${session.turns}\n`);
      process.stderr.write(`  ${c.dim('Tools')}        ${session.totalToolCalls} total, ${session.toolCalls} last turn\n`);
      process.stderr.write(`  ${c.dim('Duration')}     ${formatElapsed(session.startTime)}\n`);
      if (session.isByok) {
        process.stderr.write(`  ${c.dim('Billing')}      ${c.green('BYOK')} ${c.dim('(provider-billed)')}\n`);
      } else {
        // Server-authoritative remaining balance; fall back to the per-session
        // charged tally when balance hasn't been pushed yet.
        if (session.subscriptionTier) {
          process.stderr.write(`  ${c.dim('Plan')}         ${c.brand(session.subscriptionTier.toUpperCase())}\n`);
        }
        const messageWindow = formatMessageWindow(session.rateLimit);
        if (messageWindow) {
          process.stderr.write(`  ${c.dim('Messages')}     ${messageWindow}\n`);
        }
        if (typeof session.creditsTotal === 'number') {
          const limit = session.creditsLimit ? ` ${c.dim('/ ' + formatCredits(session.creditsLimit))}` : '';
          const used = session.creditsCharged ? ` ${c.dim(`(${formatCredits(session.creditsCharged)} used this session)`)}` : '';
          process.stderr.write(`  ${c.dim('Credits')}      ${formatCredits(session.creditsTotal)}${limit}${used}\n`);
        } else if (session.creditsCharged) {
          process.stderr.write(`  ${c.dim('Credits')}      ${formatCredits(session.creditsCharged)} ${c.dim('(used this session)')}\n`);
        }
      }
      process.stderr.write(`  ${c.dim('CWD')}          ${safeCwd()}\n`);

      // Cache — PRD-071 §1.2. Only surface when we have data; a fresh session
      // shows nothing rather than a misleading "0%".
      const cache = computeCacheTotals();
      if (cache.read > 0 || cache.write > 0) {
        const readLabel = formatTokens(cache.read);
        const writeLabel = formatTokens(cache.write);
        process.stderr.write(`  ${c.dim('Cache')}        ${cache.hitRate}% hit ${c.dim('·')} ${readLabel} read ${c.dim('·')} ${writeLabel} write\n`);
      }

      // Permissions
      process.stderr.write(`\n  ${c.bold('Permissions')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
      process.stderr.write(`  ${c.dim('Approved')}     ${approvalSummary.approved}  ${c.dim('Denied')} ${approvalSummary.denied}\n`);
      if (approvalSummary.autoApproveAll) {
        process.stderr.write(`  ${c.dim('Mode')}         ${c.yellow('approve-all active')}\n`);
      }
      if (approvalSummary.autoApprovedTypes.length > 0) {
        process.stderr.write(`  ${c.dim('Auto-types')}   ${approvalSummary.autoApprovedTypes.join(', ')}\n`);
      }
      if (approvalSummary.trust) {
        process.stderr.write(`  ${c.dim('Trust')}        ${approvalSummary.trust.sessionRules} session, ${approvalSummary.trust.projectRules} project rules\n`);
      }
      process.stderr.write(`  ${c.dim('Blocked')}      ${session.blockedOps} by safety guardrails\n`);

      // Orchestration
      if (session.delegations.length > 0 || session.phases.length > 0) {
        process.stderr.write(`\n  ${c.bold('Orchestration')}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
        if (session.delegations.length > 0) {
          process.stderr.write(`  ${c.dim('Delegations')}  ${session.delegations.length}\n`);
          for (const d of session.delegations.slice(-5)) {
            process.stderr.write(`    ${c.dim(d.from)} ${c.brand('→')} ${d.to}\n`);
          }
        }
        if (session.phases.length > 0) {
          process.stderr.write(`  ${c.dim('Phases')}       ${session.phases.map(p => p.name).join(' → ')}\n`);
        }
      }

      // Files changed
      if (session.filesChanged.length > 0) {
        process.stderr.write(`\n  ${c.bold('Files Changed')} ${c.dim(`(${session.filesChanged.length})`)}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
        for (const f of session.filesChanged.slice(-10)) {
          process.stderr.write(`  ${c.dim('~')} ${f}\n`);
        }
        if (session.filesChanged.length > 10) {
          process.stderr.write(`  ${c.dim(`  ...and ${session.filesChanged.length - 10} more`)}\n`);
        }
      }

      // System
      process.stderr.write(`\n  ${c.bold('System')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
      process.stderr.write(`  ${c.dim('Node')}         ${process.version}\n`);
      process.stderr.write(`  ${c.dim('Platform')}     ${process.platform} ${os.arch()}\n`);
      process.stderr.write(`  ${c.dim('Heap')}         ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB\n`);
      process.stderr.write(`  ${c.dim('Memory')}       ${((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1)}G / ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}G\n\n`);
      return;
    }

    case '/settings': {
      const sub = rest.trim() || 'policy';
      if (sub === 'help') {
        renderHelp('settings');
        return;
      }
      if (sub !== 'policy') {
        process.stderr.write(`  ${c.gray('Usage: /settings policy  or  /help settings')}\n`);
        return;
      }
      const effective = loadEffectivePolicy({ cwd: safeCwd() });
      ctx.effectivePolicy = effective;
      const rows = formatPolicySourceRows(effective);
      process.stderr.write(`\n  ${c.bold('Effective Policy')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(86))}\n`);
      for (const row of rows.slice(0, 80)) {
        const value = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
        process.stderr.write(`  ${c.brand(row.key.padEnd(38))} ${c.dim(row.source.padEnd(8))} ${String(value).slice(0, 34)}\n`);
      }
      if (rows.length > 80) process.stderr.write(`  ${c.dim(`...and ${rows.length - 80} more`)}\n`);
      const projectLayer = effective.layers.find(l => l.name === 'project');
      if (projectLayer?.error) {
        process.stderr.write(`\n  ${c.yellow('Project config error:')} ${projectLayer.error}\n`);
      }
      process.stderr.write('\n');
      return;
    }

    case '/stats': {
      const os = await import('node:os');
      const mem = process.memoryUsage();
      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();
      const totalTokens = session.inputTokens + session.outputTokens;
      const ctxPct = Math.min(100, (totalTokens / 200000) * 100);

      process.stderr.write(`\n  ${c.bold('Metrics')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      process.stderr.write(`  ${progressBar(ctxPct, 15, 'Context')} ${(totalTokens / 1000).toFixed(1)}k tok\n`);
      process.stderr.write(`  ${progressBar(Math.round((usedMem / totalMem) * 100), 15, 'Memory')} ${(usedMem / 1024 / 1024 / 1024).toFixed(1)}G\n`);
      process.stderr.write(`  ${progressBar(Math.round((mem.heapUsed / mem.heapTotal) * 100), 15, 'Heap')} ${(mem.heapUsed / 1024 / 1024).toFixed(0)}M\n`);
      process.stderr.write(`  ${c.gray('Turns:')}     ${session.turns}\n`);
      process.stderr.write(`  ${c.gray('Tools:')}     ${session.toolCalls}\n`);
      process.stderr.write(`  ${c.gray('Blocked:')}   ${session.blockedOps}\n`);
      if (session.isByok) {
        process.stderr.write(`  ${c.gray('Billing:')}   ${c.green('BYOK')} ${c.dim('(provider-billed)')}\n`);
      } else {
        process.stderr.write(`  ${c.gray('Credits:')}   ${formatCredits(costToCredits(session.totalCost))}${session.costAccurate ? '' : c.dim(' (est)')}\n`);
      }
      process.stderr.write(`  ${c.gray('Elapsed:')}  ${formatElapsed(session.startTime)}\n\n`);
      return;
    }

    case '/cost': {
      if (session.isByok) {
        process.stderr.write(`\n  ${c.bold('Billing')}  ${c.green('BYOK')} ${c.dim('— you pay your model provider directly. Kepler does not charge credits for BYOK usage.')}\n\n`);
        return;
      }
      // Prefer server-authoritative numbers when available.
      const used = session.creditsCharged || 0;
      const usedLabel = formatCredits(used);
      process.stderr.write(`\n  ${c.bold('Session Credits')}  ${c.brand(usedLabel)}`);
      if (used > 0 && !session.creditsCharged) process.stderr.write(`  ${c.yellow('(estimated)')}`);
      process.stderr.write('\n');
      if (session.subscriptionTier && typeof session.creditsTotal === 'number') {
        const remaining = formatCredits(session.creditsTotal);
        const limit = session.creditsLimit ? ` / ${formatCredits(session.creditsLimit)}` : '';
        process.stderr.write(`  ${c.dim('Plan')}            ${c.brand(session.subscriptionTier.toUpperCase())}  ${c.dim('· remaining')} ${c.brand(remaining)}${c.dim(limit)}\n`);
      }
      const messageWindow = formatMessageWindow(session.rateLimit);
      if (messageWindow) {
        process.stderr.write(`  ${c.dim('Messages')}        ${messageWindow}\n`);
      }
      process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);

      if (session.costBreakdown.length > 0) {
        // Header
        process.stderr.write(`  ${c.dim('Model'.padEnd(36))}${c.dim('Input'.padStart(10))}${c.dim('Output'.padStart(10))}${c.dim('Cache'.padStart(10))}${c.dim('Credits'.padStart(10))}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);

        for (const b of session.costBreakdown) {
          const modelLabel = b.model === 'unknown' ? c.yellow('unknown model') : b.model;
          const roleTag = b.role && b.role !== 'unknown' ? ` ${c.dim(`(${b.role})`)}` : '';
          const cacheTokens = (b.cache_read_tokens || 0) + (b.cache_creation_tokens || 0);
          const costStr = b.free ? c.green('free') : formatCredits(costToCredits(b.cost));

          process.stderr.write(
            `  ${(modelLabel + roleTag).padEnd(36)}` +
            `${formatTokens(b.input_tokens).padStart(10)}` +
            `${formatTokens(b.output_tokens).padStart(10)}` +
            `${(cacheTokens > 0 ? formatTokens(cacheTokens) : '—').padStart(10)}` +
            `${costStr.padStart(10)}\n`
          );
        }

        process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);
      }

      process.stderr.write(
        `  ${c.bold('Total'.padEnd(36))}` +
        `${formatTokens(session.inputTokens).padStart(10)}` +
        `${formatTokens(session.outputTokens).padStart(10)}` +
        `${''.padStart(10)}` +
        `${formatCredits(costToCredits(session.totalCost)).padStart(10)}\n`
      );
      process.stderr.write(`  ${c.dim(`Turns: ${session.turns}  Duration: ${formatElapsed(session.startTime)}`)}\n\n`);
      return;
    }

    case '/last':
      expandLast();
      return;

    case '/expand': {
      const arg = rest.trim();
      if (!arg) { expandLast(); return; }
      if (arg === 'all') { expandIndex('all'); return; }
      const n = Number(arg);
      if (!Number.isFinite(n)) {
        process.stderr.write(`  ${c.gray('Usage: /expand [n|all] — n is the 1-based index from the start of the session')}\n`);
        return;
      }
      // Users pass 1-based; getCard accepts negative (-1 = last) or positive index.
      expandIndex(n > 0 ? n - 1 : n);
      return;
    }

    case '/fold':
      process.stderr.write(`  ${c.gray('Output is folded by default — there is nothing to hide. Use /last or d to expand.')}\n`);
      return;

    case '/undo': {
      const result = ctx.checkpoints?.undo();
      if (!result) {
        process.stderr.write(`  ${c.gray('No checkpoints to undo.')}\n`);
        return;
      }
      if (result.restored) {
        process.stderr.write(`  ${c.green('↩')} ${c.dim('Restored')} ${result.filePath}\n`);
      } else {
        process.stderr.write(`  ${c.red('✗')} ${c.dim('Undo failed: ' + (result.error || 'unknown error'))}\n`);
      }
      return;
    }

    case '/checkpoint': {
      const list = ctx.checkpoints?.list(10) || [];
      if (!list.length) {
        process.stderr.write(`  ${c.gray('No checkpoints recorded yet — they are taken automatically before each edit.')}\n`);
        return;
      }
      process.stderr.write(`\n  ${c.bold('Recent checkpoints')}\n  ${c.gray('─'.repeat(40))}\n`);
      for (const ckpt of list) {
        const when = String(ckpt.timestamp).slice(11, 19);
        process.stderr.write(`  ${c.gray(when)}  ${c.white(ckpt.file)}  ${c.gray(formatTokens(ckpt.size) + ' bytes')}\n`);
      }
      process.stderr.write(`\n  ${c.gray('/undo restores the most recent one')}\n\n`);
      return;
    }

    case '/preflight': {
      await runPreflight({ auth: ctx.auth, cwd: safeCwd(), version: VERSION });
      return;
    }

    case '/report': {
      if (Object.keys(session.toolCounts).length === 0 && session.filesChanged.length === 0 && session.filesRead.length === 0) {
        process.stderr.write(`  ${c.gray('Nothing to report yet — run a task first.')}\n`);
        return;
      }
      const state = {
        task: session.lastTask,
        success: true,
        filesChanged: session.filesChanged,
        filesRead: session.filesRead,
        toolCounts: session.toolCounts,
        subAgents: { ...session.subAgentCounts, savedUsd: session.isByok ? 0 : session.savedUsd },
        costUsd: session.isByok ? null : session.totalCost,
        durationS: (Date.now() - session.startTime) / 1000,
        nextActions: ['/commit', '/pr', '/undo'],
        cwd: safeCwd(),
      };
      const out = saveReport(state, { cwd: safeCwd() });
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Saved')} ${out}\n`);
      return;
    }

    case '/why': {
      if (!session.lastReasoning) {
        process.stderr.write(`  ${c.gray('No reasoning captured yet for this session.')}\n`);
        return;
      }
      process.stderr.write(`\n  ${c.bold('Last reasoning')}\n  ${c.gray('─'.repeat(40))}\n`);
      for (const line of String(session.lastReasoning).split('\n')) {
        process.stderr.write(`  ${c.dim(line)}\n`);
      }
      process.stderr.write('\n');
      return;
    }

    case '/map': {
      try {
        const resources = ctx.toolExecutor?.getProjectResources?.() || [];
        if (!resources.length) {
          process.stderr.write(`  ${c.gray('No project resources registered yet. Use get_project_overview to register one.')}\n`);
          return;
        }
        process.stderr.write(`\n  ${c.bold('Registered projects')}\n  ${c.gray('─'.repeat(40))}\n`);
        for (const r of resources) {
          process.stderr.write(`  ${c.brand('•')} ${c.white(r.id || r.name || '?')}  ${c.dim(r.root || r.path || '')}\n`);
        }
        process.stderr.write('\n');
      } catch (err) {
        process.stderr.write(`  ${c.red('/map failed: ' + err.message)}\n`);
      }
      return;
    }

    case '/budget': {
      const arg = rest.trim();
      if (!arg) {
        const current = session.budgetUsd ? `$${session.budgetUsd.toFixed(2)}` : 'not set';
        process.stderr.write(`  ${c.dim('Budget cap:')} ${c.brand(current)} ${c.dim('· set with /status budget <amount> or clear with /status budget clear')}\n`);
        return;
      }
      if (arg === 'clear' || arg === 'off') {
        session.budgetUsd = null;
        session.budgetExceeded = false;
        process.stderr.write(`  ${c.gray('Budget cap cleared.')}\n`);
        return;
      }
      const n = Number(arg.replace(/^\$/, ''));
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`  ${c.gray('Usage: /budget <amount in USD>  or  /budget clear')}\n`);
        return;
      }
      session.budgetUsd = n;
      session.budgetExceeded = false;
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Budget set: ')} $${n.toFixed(2)}\n`);
      return;
    }

    case '/quiet':
    case '/verbose':
    case '/surgical': {
      const mode = cmd === '/quiet' ? V_MODES.QUIET
                : cmd === '/verbose' ? V_MODES.VERBOSE
                : V_MODES.SURGICAL;
      setVerbosity(mode);
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Verbosity: ')} ${c.brand(verbosityLabel(mode))}\n`);
      return;
    }

    case '/compact': {
      await compactCurrentSession(ctx, rest);
      return;
    }

    case '/clear':
      session.history.length = 0;
      session.agentHistory.length = 0;
      session.toolCalls = 0;
      process.stderr.write(`  ${c.gray('Conversation cleared.')}\n`);
      return;

    case '/git': {
      const { execSync } = await import('node:child_process');
      try { process.stdout.write(execSync('git status --short --branch', { encoding: 'utf-8' }) + '\n'); }
      catch (e) { process.stderr.write(`  ${c.red(e.message)}\n`); }
      return;
    }

    case '/diff': {
      const { execSync } = await import('node:child_process');
      try {
        const diff = execSync('git diff --no-ext-diff --unified=3', {
          encoding: 'utf-8',
          maxBuffer: 2 * 1024 * 1024,
        });
        process.stdout.write(diff ? renderDiff(diff) + '\n' : c.dim('(no changes)') + '\n');
      }
      catch (e) { process.stderr.write(`  ${c.red(e.message)}\n`); }
      return;
    }

    case '/safety': {
      const { getSafetyRules } = await import('../core/safety.mjs');
      const rules = getSafetyRules();
      const summary = ctx.approval.getSummary();
      process.stderr.write(`\n  ${c.bold('Safety Guardrails')} ${c.green('ACTIVE')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      process.stderr.write(`  ${c.gray('Approval mode:')}  ${ctx.approval.getModeLabel()}\n`);
      process.stderr.write(`  ${c.gray('Approved:')}       ${summary.approved}  ${c.gray('Denied:')} ${summary.denied}\n`);
      process.stderr.write(`  ${c.gray('Protected files:')} ${rules.protectedNames.join(', ')}\n`);
      process.stderr.write(`  ${c.gray('Source dirs:')}     ${rules.sourceDirs.join(', ')}\n`);
      process.stderr.write(`  ${c.gray('Blocked patterns:')} ${rules.blockedPatterns}\n`);
      process.stderr.write(`  ${c.gray('High-risk patterns:')} ${rules.highRiskPatterns}\n`);
      process.stderr.write(`  ${c.gray('Ops blocked:')}     ${session.blockedOps}\n\n`);
      return;
    }

    case '/revoke': {
      const wasActive = ctx.approval.revoke();
      if (wasActive) {
        process.stderr.write(`  ${c.green('✓')} ${c.dim('Auto-approvals revoked. All tool calls will prompt again.')}\n`);
      } else {
        process.stderr.write(`  ${c.gray('No auto-approvals were active.')}\n`);
      }
      return;
    }

    case '/sessions': {
      const resumable = await listResumableSessions();
      if (resumable.length === 0) {
        process.stderr.write(`  ${c.gray('No resumable sessions found.')}\n`);
        return;
      }
      process.stderr.write(`\n  ${c.bold('Resumable Sessions')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(60))}\n`);
      for (const s of resumable) {
        const date = sessionListTimestamp(s);
        const instr = oneLineInstruction(s.instruction, 72);
        const project = s.project || path.basename(s.projectPath || '') || '(unknown)';
        process.stderr.write(`  ${c.brand(s.sessionId)}  ${c.brand(project)}  ${c.dim(date)}  ${messageCountLabel(s.messageCount)}  ${c.dim(instr)}\n`);
      }
      process.stderr.write(`\n  ${c.dim('Resume with:')} kepler --resume <sessionId>\n`);
      return;
    }

    case '/resume': {
      // PRD-068 §5.14: one-prompt picker, context-length driven auto-decision,
      // direct-resume mode flags (--full, --tail10, --tail20, --summary).
      const parts = input.split(/\s+/).filter(Boolean);
      const forcedFlag = parts.find(p => /^(--full|--tail10|--tail20|--recap|--summary|-f|-1|-2|-r|-s)$/.test(p));
      const forcedMode = forcedFlag
        ? ({ '--full': 'full', '-f': 'full',
             '--tail10': 'tail-10', '-1': 'tail-10',
             '--tail20': 'tail-20', '-2': 'tail-20',
             '--recap': 'tail-20', '-r': 'tail-20',
             '--summary': 'summary', '-s': 'summary' })[forcedFlag]
        : null;
      const targetId = parts.slice(1).find(p => !p.startsWith('-'));

      const resumable = await listResumableSessions();
      if (resumable.length === 0) {
        process.stderr.write(`  ${c.gray('No resumable sessions found.')}\n`);
        return;
      }

      // 1. Resolve which session to resume.
      let picked = null;
      if (targetId) {
        picked = resumable.find(s => s.sessionId === targetId || s.sessionId?.startsWith(targetId));
        if (!picked) {
          process.stderr.write(`  ${c.yellow('!')} ${c.dim(`No session found matching id: ${targetId}`)}\n`);
          return;
        }
      } else {
        while (!picked) {
          const pickResult = await pickResumableSession(resumable, ctx);
          if (!pickResult) { process.stderr.write(`\n  ${c.dim('Cancelled.')}\n`); return; }
          if (pickResult.action === 'resume') {
            if (!pickResult.session) {
              process.stderr.write(`\n  ${c.yellow('!')} ${c.dim('Empty session — pick another.')}\n`);
              continue;
            }
            picked = pickResult.session;
            break;
          }
          if (pickResult.action === 'preview') {
            // Yield to the event loop so any queued keystrokes from the picker
            // don't spill into the preview's stdin listener (PRD-068 §5.14 bugfix).
            await new Promise(r => setImmediate(r));
            const previewResult = await previewResumeSession(pickResult.session, ctx);
            if (previewResult && previewResult.action === 'resume') {
              picked = pickResult.session;
              // Preview already committed to a mode — skip the threshold overlay.
              picked._presetMode = previewResult.mode;
              break;
            }
            if (previewResult === null) {
              // getSessionDetail failed — file missing, unreadable, or huge.
              // Tell the user why before looping back to the picker.
              process.stderr.write(`  ${c.yellow('!')} ${c.dim('Could not load transcript for preview — pick another session or press Enter to resume without preview.')}\n`);
            }
            // Yield again so the loop-back render doesn't collide with the
            // just-closed preview's stdin cleanup.
            await new Promise(r => setImmediate(r));
          }
        }
      }

      // 2. Decide the mode. Force-flag > preview-preset > auto-decide > overlay.
      let mode = forcedMode || picked._presetMode || null;
      if (!mode) {
        const currentModel = session?.model || session?.user?.default_reasoning_model || null;
        const decision = decideResumeMode({
          transcriptTokens: picked.contextTokens,
          model: currentModel,
          settings: ctx.effectivePolicy?.policy?.resume ? { resume: ctx.effectivePolicy.policy.resume } : {},
        });
        decision.resumeSummary = picked.resumeSummary || null;
        if (decision.mode === 'full') {
          mode = 'full';
        } else {
          // Yield before attaching the overlay listener — same race guard as
          // the preview branch above. Prevents a queued Enter from the picker
          // slipping into the overlay's stdin, which otherwise looked like a
          // duplicate picker render.
          await new Promise(r => setImmediate(r));
          const chosen = await chooseThresholdMode(ctx, decision);
          if (!chosen) { process.stderr.write(`\n  ${c.dim('Cancelled.')}\n`); return; }
          mode = chosen;
        }
      }

      // 3. Activate.
      const source = targetId ? 'direct' : 'picker';
      const progress = startResumeProgress(mode);
      let resumed;
      try {
        resumed = await ctx.activateResumedSession(picked.sessionId, source, mode, picked, {
          onProgress: progress.update,
          onProgressStop: progress.stop,
        });
      } finally {
        progress.stop();
      }
      if (!resumed.ok) {
        if (resumed.reason === 'cwd-cancelled') {
          process.stderr.write(`\n  ${c.dim('Cancelled.')}\n`);
        } else {
          process.stderr.write(`\n  ${c.yellow('!')} ${c.dim(resumed.reason || 'No messages in that session.')}\n`);
        }
        return;
      }

      // 4. Report — succinct honest single line, then optional hydration warning.
      const toolSummary = resumed.stats && resumed.stats.toolCalls
        ? `${resumed.stats.toolCalls} tool calls`
        : `${resumed.messages} msgs`;
      const summaryLabel = mode !== 'full' && resumed.summarySource
        ? ` · summary: ${resumed.summarySource}`
        : '';
      process.stderr.write(`\n  ${c.green('↺')} ${c.dim('Resumed')} ${c.brand(picked.project || path.basename(safeCwd()))} ${c.dim(`· ${resumed.messages} msgs · ${toolSummary} · mode: ${resumeModeLabel(mode)}${summaryLabel}`)}\n`);
      if (resumed.summaryWarning) {
        process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`backend summary unavailable — using local summary (${resumed.summaryWarning})`)}\n`);
      }
      if (resumed.hydrationFailures?.length) {
        for (const failure of resumed.hydrationFailures) {
          process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`could not re-read project root: ${failure}`)}\n`);
        }
      }
      if (resumed.stayedInCwd) {
        process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`resumed transcript from ${resumed.savedProjectPath} — running against ${safeCwd()}`)}\n`);
      }

      // 5. Show continuity context. Non-summary modes use the captured
      //    kepler_event stream when available so the terminal replay matches
      //    the original styled interaction; older sessions fall back to
      //    reconstructed text.
      if (mode === 'summary' && resumed.summary) {
        // In summary mode the agent gets only the summary block. Show it so
        // the user knows what continuity context was included.
        process.stderr.write(`\n  ${c.bold('Continuity Summary')}\n`);
        process.stderr.write(`  ${c.gray('─'.repeat(80))}\n`);
        for (const line of resumed.summary.split('\n')) {
          process.stderr.write(`  ${c.dim(line)}\n`);
        }
        process.stderr.write('\n');
      } else if (resumed.replayEvents?.length) {
        renderResumePreview(resumed);
      } else if (resumed.history?.length) {
        // Full/tail modes feed real conversation to the agent — show
        // the tail so the user has visual context. Cap at 30 entries to avoid
        // flooding the terminal on long sessions.
        renderHistoryEntries(resumed.history, {
          limit: 30,
          maxChars: 200,
          title: mode?.startsWith('tail-') ? `Recent turns (${mode.replace('tail-', 'last ')})` : 'Conversation history (last 30 entries)',
        });
      }
      return;
    }

    case '/agents':
      process.stderr.write(`\n  ${c.bold('Built-in Agents')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(44))}\n`);
      for (const agent of BUILTIN_AGENTS) {
        process.stderr.write(`  ${c.brand(('/' + agent.command).padEnd(14))} ${agent.description}\n`);
        process.stderr.write(`  ${' '.repeat(14)} ${c.gray(agent.detail)}\n`);
      }
      process.stderr.write(`\n  ${c.gray('Usage: /<agent> <instruction>')}\n`);
      process.stderr.write(`  ${c.gray('Example: /explore how does the auth flow work?')}\n\n`);
      return;

    case '/explore':
    case '/review':
    case '/architect': {
      if (!rest) {
        process.stderr.write(`  ${c.yellow('Usage:')} ${cmd} <instruction>\n`);
        process.stderr.write(`  ${c.gray(`Example: ${cmd} ${cmd === '/explore' ? 'how does authentication work?' : cmd === '/review' ? 'check src/core/ for bugs' : 'design a caching layer'}`)}\n`);
        return;
      }
      return await runAgent(cmd.slice(1), rest, ctx, session, renderEvent);
    }

    case '/logout': {
      const success = ctx.auth.logout();
      if (success) {
        process.stderr.write(`  ${c.green('✓')} ${c.dim('Signed out. Credentials cleared from ~/.kepler/config.json')}\n`);
        process.stderr.write(`  ${c.dim('Run /login to sign in again.')}\n`);
      } else {
        process.stderr.write(`  ${c.yellow('!')} ${c.dim('No credentials to clear.')}\n`);
      }
      return;
    }

    case '/exit':
    case '/quit':
      process.stderr.write(`\n  ${c.brand('Goodbye!')}\n\n`);
      process.exit(0);

    default:
      process.stderr.write(`  ${c.gray(`Unknown: ${cmd}. Type /help.`)}\n`);
  }
}

// ── Fetch User Profile ──

async function fetchUser(ctx) {
  const creds = ctx.auth.loadCredentials();
  if (!creds.token) return;
  try {
    const resp = await fetch(`${creds.backendUrl}/api/user/me`, {
      headers: { 'Authorization': `Bearer ${creds.token}` },
    });
    if (resp.ok) {
      session.user = await resp.json();
      session.model = session.user.default_reasoning_model || session.user.default_orchestrator_model || null;
    }
  } catch {}
}

// ── Main REPL ──
// Cache CWD at startup so safeCwd() has a fallback if the dir gets deleted

export async function startTerminalRepl() {
  _cachedCwd = process.cwd(); // Cache startup CWD for recovery

  const cliArgs = parseArgs(process.argv.slice(2));
  const auth = new TarangAuth();

  // Projects are registered and indexed on demand through get_project_overview.
  // CheckpointManager records per-file snapshots before edits so /undo works.
  let checkpoints = new CheckpointManager(safeCwd());
  let effectivePolicy = loadEffectivePolicy({ cwd: safeCwd() });
  let latestProjectContext = null;
  let latestEnvelope = null;
  let hookRunner = new HookRunner({ cwd: safeCwd() });
  let toolExecutor = createToolExecutor({ checkpoints, hookRunner });
  const skipPerms = cliArgs.freeswim;
  let approval = new ApprovalManager({ autoApprove: skipPerms, cwd: safeCwd(), policy: effectivePolicy.policy });

  // Session manager — persists conversation messages to .kepler/conversations/
  let sessionMgr = new SessionManager(safeCwd());
  _sessionMgr = sessionMgr; // expose to renderEvent

  // Local JSONL writer — writes cc-lens compatible session data to ~/.kepler/
  let jsonlWriter = new JsonlWriter(safeCwd(), VERSION);

  // Persistent stream client — session_id captured from backend on first turn
  let streamClient = null;

  const ctx = { auth, toolExecutor, approval, jsonlWriter, sessionMgr, checkpoints, effectivePolicy, latestProjectContext, latestEnvelope };

  /**
   * Activate a previously-recorded session for continuation.
   *
   * Contract (PRD-068 §5.14 and follow-up clarification):
   *   1. Keep the same sessionId. The resumed session IS the same session,
   *      not a fork. Future turns are appended to the SAME .jsonl file that
   *      was read here.
   *   2. Do not re-write the loaded transcript back to disk. The file already
   *      contains every historical entry; the load path is read-only. Any
   *      duplication would double-count tokens on the next resume.
   *   3. Fresh sessions (kepler started without /resume) get a fresh UUID
   *      the first time jsonlWriter.writeUserTurn() runs — that path is
   *      untouched by resume, so brand-new sessions never inherit an old id.
   *   4. In-memory history (session.history / session.agentHistory) mirrors
   *      what the agent will see next turn; it is NOT written back to the
   *      transcript at activation time.
   */
  async function activateResumedSession(sessionId, source = 'resume', historyMode = 'full', resumeEntry = null, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const onProgressStop = typeof options.onProgressStop === 'function' ? options.onProgressStop : () => {};
    // PRD-068 §5.14.6: JSONL is the only source. No legacy conversation fallback.
    onProgress('reading saved transcript', 14);
    const detail = await getSessionDetail(sessionId, { filePath: resumeEntry?.transcriptPath });
    if (!detail) {
      return { ok: false, reason: `No transcript found for session ${sessionId}` };
    }
    onProgress('building resume context', 28);
    const richHistory = buildResumeHistory({ ...detail, recapTailTurns: 8 }, historyMode);
    const displayHistory = richHistory.displayHistory;
    if (!displayHistory.length) {
      return { ok: false, reason: `Session ${sessionId} has no readable messages` };
    }

    // PRD-068 §5.14.7: explicit cwd confirmation if saved path differs.
    const savedProjectPath = detail?.meta?.project || '';
    let summarySource = 'local';
    let summaryWarning = '';
    if (historyMode !== 'full' && richHistory.sourceMessages?.length) {
      onProgress('summarizing transcript', 34);
      const backendSummary = await summarizeResumeTranscript({
        auth,
        toolExecutor,
        sessionId,
        projectPath: savedProjectPath || safeCwd(),
        messages: richHistory.sourceMessages,
      });
      if (backendSummary?.summary) {
        richHistory.summary = combineResumeSummaries(richHistory.priorSummary, backendSummary.summary);
        const summaryIndex = Number.isInteger(richHistory.summaryMessageIndex)
          ? richHistory.summaryMessageIndex
          : 0;
        if (richHistory.agentHistory?.[summaryIndex]) {
          const tailTurns = resumeTailTurnCount(historyMode);
          const prefix = tailTurns
            ? `Summary of earlier turns before the retained last ${tailTurns} conversation messages:\n`
            : 'Session continuity summary:\n';
          richHistory.agentHistory[summaryIndex] = {
            ...richHistory.agentHistory[summaryIndex],
            content: `${prefix}${richHistory.summary}`,
          };
        }
        summarySource = backendSummary.source || 'backend';
      } else {
        summarySource = 'local fallback';
        summaryWarning = backendSummary?.reason || 'backend summary unavailable';
      }
    } else if (historyMode !== 'full') {
      summarySource = 'not needed';
      summaryWarning = resumeTailTurnCount(historyMode)
        ? 'retained tail covers the whole transcript'
        : 'empty transcript';
    }
    const agentHistory = richHistory.agentHistory;
    const originalCwd = safeCwd();
    let switchedProject = false;
    let projectMissing = false;
    let stayedInCwd = false;
    onProgress('checking project cwd', 40);
    if (savedProjectPath && savedProjectPath !== originalCwd) {
      if (fs.existsSync(savedProjectPath)) {
        onProgressStop();
        const choice = await confirmCwdSwitch(ctx, savedProjectPath, originalCwd);
        if (choice === 'cancel') return { ok: false, reason: 'cwd-cancelled' };
        if (choice === 'switch') {
          try {
            process.chdir(savedProjectPath);
            _cachedCwd = process.cwd();
            switchedProject = true;
          } catch {
            projectMissing = true;
          }
        } else if (choice === 'stay') {
          stayedInCwd = true;
        }
      } else {
        projectMissing = true;
        process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`saved project path unavailable: ${savedProjectPath} — using current cwd`)}\n`);
      }
    }

    onProgress('rebuilding local session state', 55);
    checkpoints = new CheckpointManager(safeCwd());
    effectivePolicy = loadEffectivePolicy({ cwd: safeCwd() });
    hookRunner = new HookRunner({ cwd: safeCwd(), sessionId });
    toolExecutor = createToolExecutor({ checkpoints, hookRunner });
    approval = new ApprovalManager({ autoApprove: skipPerms, cwd: safeCwd(), policy: effectivePolicy.policy });
    if (ctx._rl) approval.setReadline(ctx._rl);
    sessionMgr = new SessionManager(safeCwd());
    sessionMgr.activateSession(sessionId, {
      instruction: detail?.meta?.firstPrompt || '',
      started_at: detail?.meta?.startTime || new Date().toISOString(),
    }, displayHistory.filter(m => m.role === 'user' || m.role === 'assistant'));
    _sessionMgr = sessionMgr;

    try { await jsonlWriter.close(); } catch {}
    jsonlWriter = new JsonlWriter(safeCwd(), VERSION);
    jsonlWriter.setSessionId(sessionId);
    if (
      historyMode !== 'full'
      && richHistory.summary
      && Number(richHistory.summaryCoveredMessageCount) > Number(richHistory.summaryCheckpointMessageCount || 0)
    ) {
      jsonlWriter.writeKeplerEvent({
        type: 'resume_summary',
        data: {
          session_id: sessionId,
          mode: historyMode,
          mode_label: resumeModeLabel(historyMode),
          summary: richHistory.summary,
          summary_source: summarySource,
          summary_warning: summaryWarning || null,
          source_message_count: richHistory.summaryCoveredMessageCount,
          previous_source_message_count: richHistory.summaryCheckpointMessageCount || 0,
          full_message_count: richHistory.fullMessageCount || 0,
        },
      });
    }
    jsonlWriter.writeKeplerEvent({
      type: 'resume_context',
      data: {
        session_id: sessionId,
        source,
        mode: historyMode,
        mode_label: resumeModeLabel(historyMode),
        messages: displayHistory.length,
        summary_source: summarySource,
        summary_injected: historyMode !== 'full' && Boolean(richHistory.agentHistory?.[richHistory.summaryMessageIndex ?? 0]?.content),
        summary_warning: summaryWarning || null,
        summary_source_message_count: richHistory.summaryCoveredMessageCount || 0,
        previous_summary_source_message_count: richHistory.summaryCheckpointMessageCount || 0,
        project_path: savedProjectPath || safeCwd(),
      },
    });

    streamClient = null;
    latestProjectContext = loadProjectContext({ cwd: safeCwd() });
    latestEnvelope = null;

    // PRD-068 §5.14.8: report hydration failures instead of swallowing them.
    const hydrationFailures = [];
    const resumeRoots = getTranscriptProjectRoots(detail);
    const rootsToRegister = [...new Set([safeCwd(), ...resumeRoots].filter(Boolean))];
    onProgress('hydrating project roots', 68);
    for (let i = 0; i < rootsToRegister.length; i++) {
      const root = rootsToRegister[i];
      onProgress(`hydrating project root ${i + 1}/${rootsToRegister.length}`, 68 + Math.round((i / Math.max(1, rootsToRegister.length)) * 18));
      try {
        await toolExecutor.execute('get_project_overview', { path: root });
      } catch {
        hydrationFailures.push(root);
      }
    }

    onProgress('preparing replay', 92);
    session.history = displayHistory;
    session.agentHistory = agentHistory;
    session.id = sessionId;
    session.turns = displayHistory.filter(m => m.role === 'user').length;
    session.lastTask = detail?.meta?.firstPrompt || session.history.find(m => m.role === 'user')?.content || '';

    Object.assign(ctx, {
      toolExecutor,
      approval,
      jsonlWriter,
      sessionMgr,
      checkpoints,
      effectivePolicy,
      latestProjectContext,
      latestEnvelope,
    });

    return {
      ok: true,
      messages: displayHistory.length,
      projectPath: savedProjectPath || safeCwd(),
      savedProjectPath,
      switchedProject,
      projectMissing,
      stayedInCwd,
      hydrationFailures,
      instruction: detail?.meta?.firstPrompt || '',
      historyMode,
      summary: richHistory.summary || '',
      summarySource,
      summaryWarning,
      history: displayHistory,
      replayEvents: detail.replayEvents || [],
      stats: richHistory.stats,
      source,
    };
  }
  ctx.activateResumedSession = activateResumedSession;

  // ── Print banner + preflight + init BEFORE mounting the status bar ──
  // The status bar shrinks the scroll region; if it mounts first, the
  // banner scrolls off-screen before the user ever sees it.
  printBanner(auth);

  // Preflight diagnostic (PRD-055 §9). Non-blocking; opt-out via
  // KEPLER_NO_PREFLIGHT=1 (used by tests / scripted runs).
  if (process.env.KEPLER_NO_PREFLIGHT !== '1' && !cliArgs.freeswim) {
    try { await runPreflight({ auth, cwd: safeCwd(), version: VERSION }); }
    catch { /* preflight is best-effort */ }
  }

  // ── Initialization ──
  process.stderr.write(`  ${c.brand('⠋')} ${c.dim('Initializing...')}\r`);
  await fetchUser(ctx);

  // Clear the spinner line
  process.stderr.write(`\r${' '.repeat(60)}\r`);
  process.stderr.write(`  ${c.green('✓')} ${c.dim('Ready; projects will be indexed on demand')}\n`);
  if (session.user) {
    process.stderr.write(`  ${c.green('✓')} ${c.dim(`Logged in as ${session.user.github_username || session.user.email || 'user'}`)}\n`);
  }
  // ── Resume previous session ──
  if (cliArgs.resume) {
    const lastSession = cliArgs.resumeSessionId
        ? { sessionId: cliArgs.resumeSessionId }
        : sessionMgr.getLastSession();

    if (lastSession) {
      const resumed = await activateResumedSession(lastSession.sessionId, 'startup');
      if (resumed.ok) {
        process.stderr.write(`  ${c.green('↺')} ${c.dim(`Resumed session: ${messageCountLabel(resumed.messages)}`)}`);
        process.stderr.write(` ${c.dim('· project')} ${c.brand(path.basename(safeCwd()))}`);
        process.stderr.write(` ${c.dim(`· agent ${resumed.historyMode}`)}`);
        if (resumed.switchedProject) process.stderr.write(` ${c.dim('(cwd restored)')}`);
        if (resumed.projectMissing) process.stderr.write(` ${c.yellow('(saved project path unavailable; using current cwd)')}`);
        if (resumed.instruction) process.stderr.write(` ${c.dim('—')} ${c.dim(resumed.instruction.slice(0, 50))}`);
        process.stderr.write('\n');
        renderResumePreview(resumed);
      } else {
        process.stderr.write(`  ${c.yellow('!')} ${c.dim(resumed.reason || 'No conversation found for session ' + lastSession.sessionId)}\n`);
      }
    } else {
      process.stderr.write(`  ${c.yellow('!')} ${c.dim('No previous session to resume')}\n`);
    }
  }

  process.stderr.write(`\n  ${c.dim('Press')} ${c.brand('Enter')} ${c.dim('to start, or type a prompt below.')}\n`);

  // Mission Control status bar is OPT-IN as of v2.0.1.
  // Set KEPLER_STATUS_BAR=1 (or KEPLER_MISSION=1) to enable the persistent
  // bottom-anchored ORBIT bar. Default off because the DECSTBM scroll
  // region was eating the prompt visibility on some terminals (issue
  // observed during v2.0.0 testing). The orbit state machine and tool
  // cards still work without the bar — the bar is just the rendering.
  const statusBarEnabled = (
    process.env.KEPLER_STATUS_BAR === '1' || process.env.KEPLER_MISSION === '1'
  ) && term().isTTY && !term().plain;
  if (statusBarEnabled) {
    _orbit = createOrbit();
    attachOrbit(_orbit);
    process.on('beforeExit', unmountStatusBar);
    process.on('exit',       unmountStatusBar);
  }

  // The prompt label is the USER speaking, not the agent. Use the signed-in
  // GitHub handle if known, otherwise fall back to "You".
  //
  // readline counts every byte of the prompt as a visible column when it
  // computes cursor position for line-wrapping; ANSI color codes throw the
  // math off and produce duplicated text on wrap. Wrap each escape sequence
  // in SOH (\x01) ... STX (\x02) so readline skips it when measuring width.
  function rlSafe(s) {
    return String(s || '').replace(/\x1b\[[0-9;]*m/g, '\x01$&\x02');
  }
  function userPrompt() {
    const who = session.user?.github_username || session.user?.email?.split('@')[0] || 'You';
    return rlSafe(`${c.brand(who)} ${c.dim('›')} `);
  }

  function printInputSeparator() {
    if (term().plain) return;
    const w = process.stdout.columns || 80;
    const label = ` ${c.brand('input')} `;
    const labelPlain = stripAnsi(label);
    const lineLen = Math.max(0, w - labelPlain.length - 4);
    process.stderr.write(`${c.dim('╭─')}${label}${c.dim('─'.repeat(lineLen))}\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: userPrompt(),
    completer: (line) => {
      if (line.startsWith('/')) {
        return [commandCompletions(line), line];
      }
      return [[], line];
    },
    historySize: 100,
  });

  // Give approval manager access to readline for pause/resume
  approval.setReadline(rl);
  ctx._rl = rl; // expose to /resume command for readline pause
  let inputActive = false;
  let slashHintVisible = false;

  function promptBottomPaddingLines() {
    if (!process.stderr.isTTY || term().plain) return 0;
    const raw = process.env.KEPLER_PROMPT_BOTTOM_PADDING ?? '1';
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(3, n);
  }

  function renderSlashHint(line = '') {
    if (!process.stderr.isTTY || term().plain || !inputActive || !promptBottomPaddingLines()) return;
    const suggestions = slashCommandSuggestions(line);
    const cols = process.stdout.columns || 80;
    const maxVisible = Math.max(20, cols - 4);
    const parts = [];
    let visible = 0;
    for (const { command, description } of suggestions) {
      const raw = `${command}${description ? ` ${description}` : ''}`;
      const sep = parts.length ? '  ·  ' : '';
      if (visible + sep.length + raw.length > maxVisible) break;
      if (sep) parts.push(c.dim(sep));
      parts.push(`${c.brand(command)}${description ? c.dim(` ${description}`) : ''}`);
      visible += sep.length + raw.length;
    }
    if (parts.length && parts.length < suggestions.length) parts.push(c.dim('  …'));
    const display = parts.join('');

    process.stderr.write('\x1b[s');      // save cursor inside readline input
    process.stderr.write('\x1b[1E');     // move to reserved row below input
    process.stderr.write('\x1b[2K\r');   // clear hint row
    if (display) process.stderr.write(`  ${display}`);
    process.stderr.write('\x1b[u');      // restore cursor to readline input
    slashHintVisible = Boolean(display);
  }

  function clearSlashHint() {
    if (!slashHintVisible || !process.stderr.isTTY || term().plain) {
      slashHintVisible = false;
      return;
    }
    process.stderr.write('\x1b[s\x1b[1E\x1b[2K\r\x1b[u');
    slashHintVisible = false;
  }

  function reservePromptBottomPadding() {
    const lines = promptBottomPaddingLines();
    if (!lines) return;
    process.stderr.write(`${'\n'.repeat(lines)}\x1b[${lines}A\r`);
  }

  function promptInputLine() {
    rl.setPrompt(userPrompt());  // refresh label in case session.user resolved
    reservePromptBottomPadding();
    inputActive = true;
    rl.prompt();
  }

  // Helper: show prompt with separator + vertical breathing room
  function showPrompt() {
    printPromptBlock();
    process.stderr.write('\n');  // half-inch vertical gap above input line
    printInputSeparator();
    promptInputLine();
  }

  showPrompt();

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on('keypress', () => {
      if (!inputActive) return;
      setImmediate(() => {
        if (!inputActive) return;
        if (String(rl.line || '').trimStart().startsWith('/')) {
          renderSlashHint(rl.line);
        } else {
          clearSlashHint();
        }
      });
    });
  }

  // Guard against concurrent line handlers.
  //
  // rl.on('line', async ...) does NOT wait for the previous async handler to
  // complete before firing again. So a stray '\n' (from readline processing
  // '\r\n' as two events after an interactive picker resumes it, or from a
  // paste) can spawn a second handleCommand run while the first is still
  // awaiting inside /resume, /login, etc. Symptom: the picker or overlay
  // appears to render twice.
  //
  // Rules:
  //   - Only one command runs at a time.
  //   - Empty lines that arrive while a command is in flight are dropped
  //     (they are almost always stray '\n's from raw-mode key handling).
  //   - Non-empty lines are queued and replayed after the current command
  //     finishes, so the user can queue up work while a long-running command
  //     is still executing.
  let _lineInFlight = false;
  const _queuedLines = [];
  rl.on('line', async (line) => {
    if (_lineInFlight) {
      if (line && line.trim()) _queuedLines.push(line);
      return;
    }
    _lineInFlight = true;
    try {
      await _handleLine(line);
    } finally {
      _lineInFlight = false;
      if (_queuedLines.length) {
        const next = _queuedLines.shift();
        // Fire the next queued line asynchronously so we don't hold this
        // finally block open while the next command runs.
        setImmediate(() => rl.emit('line', next));
      }
    }
  });

  async function _handleLine(line) {
    inputActive = false;
    clearSlashHint();
    const input = line.trim();
    if (!input) { promptInputLine(); return; }

    // Save to input history
    session.inputHistory.push(input);

    // Slash commands
    if (input.startsWith('/')) {
      await handleCommand(input, ctx);
      showPrompt();
      return;
    }

    // Budget cap (PRD-055 §10). Stop before the next paid call when exceeded.
    if (session.budgetUsd && session.totalCost >= session.budgetUsd) {
      session.budgetExceeded = true;
      process.stderr.write(`  ${c.yellow('⏹')} ${c.dim(`Budget reached ($${session.totalCost.toFixed(2)} of $${session.budgetUsd.toFixed(2)}). Use /budget clear to continue.`)}\n`);
      showPrompt();
      return;
    }

    // Regular prompt
    const userMessage = { role: 'user', content: input };
    session.history.push(userMessage);
    session.agentHistory.push(userMessage);
    session.turns++;
    session.toolCalls = 0;
    session.lastTask = input;
    // Reset per-turn counts so the mission report reflects this turn only.
    session.toolCounts = {};
    session.subAgentCounts = {};
    session.filesRead = [];
    session.savedUsd = 0;
    session._lastEmittedThinking = '';
    session.creditsLowWarned = false;
    session.msgsLowWarned = false;

    // Tell the orbit a new turn started — switches to DISCOVERY and updates
    // task / turn counters in the status bar.
    if (_orbit) _orbit.onUserInput(input);

    // Start session tracking on first turn
    if (session.turns === 1) {
      sessionMgr.start(input);
    }
    let userTurnWritten = false;
    const writeCurrentUserTurn = () => {
      if (userTurnWritten) return;
      jsonlWriter.writeUserTurn(input);
      jsonlWriter.writeHistory(input);
      userTurnWritten = true;
    };
    if (session.id) writeCurrentUserTurn();

    const creds = auth.loadCredentials();
    if (!creds.token) {
      process.stderr.write(`  ${c.red('Not logged in. Run /login first.')}\n`);
      showPrompt();
      return;
    }

    // Kepler response label
    process.stderr.write(`\n${c.bold(c.brand('kepler'))}\n`);

    // Create or reuse stream client — sessionId persists across turns
    if (!streamClient || streamClient.baseUrl !== creds.backendUrl || streamClient.token !== creds.token) {
      streamClient = new TarangStreamClient({
        baseUrl: creds.backendUrl,
        token: creds.token,
        toolExecutor,
        approvalManager: approval,
      });
    }
    const client = streamClient;
    if (session.id && !client.sessionId) {
      client.sessionId = session.id;
    }

    let assistantContent = '';

    // ── Execution keypress listener (Esc = cancel, Space = pause/resume) ──
    let executionPaused = false;
    let keypressCleanup = null;
    let execListenerActive = false;
    let lastCtrlCAt = 0; // PRD-055 §8.4: first Ctrl+C cancels, second exits

    if (process.stdin.isTTY) {
      rl.pause();
      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      execListenerActive = true;

      const onData = (data) => {
        if (!execListenerActive) return; // paused for approval menu
        const bytes = [...data];

        // Esc key (single byte 0x1b, not part of arrow sequence)
        if (bytes.length === 1 && bytes[0] === 0x1b) {
          stopSpinner();
          process.stderr.write(`\n  ${c.yellow('⏹')} ${c.dim('Cancelled.')}\n`);
          // cancel() now aborts the in-flight SSE reader; the for-await loop
          // wakes up immediately and the prompt returns. No more "stuck"
          // Cancelling… message.
          client.cancel();
          return;
        }

        // Space — toggle pause/resume
        if (bytes.length === 1 && bytes[0] === 0x20) {
          if (executionPaused) {
            executionPaused = false;
            process.stderr.write(`  ${c.green('▶')} ${c.dim('Resumed')}\n`);
            client.resume();
            if (_orbit) _orbit.onResume();
          } else {
            executionPaused = true;
            stopSpinner();
            process.stderr.write(`  ${c.yellow('⏸')} ${c.dim('Paused — press Space to resume, Esc to cancel')}\n`);
            client.pause();
            if (_orbit) _orbit.onPause();
          }
          return;
        }

        // Ctrl+C during execution — PRD-055 §8.4 two-step semantics:
        //   first press → cancel current backend run, stay in REPL
        //   second press within 2s → exit the CLI
        if (bytes[0] === 0x03) {
          stopSpinner();
          const now = Date.now();
          if (lastCtrlCAt && (now - lastCtrlCAt) < 2000) {
            process.stderr.write(`\n  ${c.dim('exiting…')}\n`);
            try { client.cancel(); } catch {}
            process.exit(0);
          }
          lastCtrlCAt = now;
          process.stderr.write(`\n  ${c.yellow('⏹')} ${c.dim('Cancelled. Press Ctrl+C again within 2s to exit.')}\n`);
          try { client.cancel(); } catch {}
          return;
        }

        // `d` — expand last tool card (Mission Control §6.2)
        if (bytes.length === 1 && (bytes[0] === 0x64 || bytes[0] === 0x44)) {
          stopSpinner();
          expandLast();
          return;
        }
      };

      process.stdin.on('data', onData);

      // Let approval manager pause/resume this listener
      approval.setExecutionHooks({
        onPause: () => { execListenerActive = false; },
        onResume: () => { execListenerActive = true; },
      });

      keypressCleanup = () => {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(wasRaw || false);
        execListenerActive = false;
        approval.setExecutionHooks({}); // clear hooks
        rl.resume();
      };
    }

    try {
      startContentStream();

      const execContext = { cwd: safeCwd() };
      if (skipPerms) execContext.freeswim = true;
      effectivePolicy = loadEffectivePolicy({ cwd: safeCwd() });
      approval.policy = effectivePolicy.policy;
      if (approval.trustStore) approval.trustStore.policy = effectivePolicy.policy;
      hookRunner.reload();
      latestProjectContext = loadProjectContext({ cwd: safeCwd(), previous: latestProjectContext });
      const projectResources = toolExecutor.getProjectResources();
      const promptHook = await hookRunner.run('UserPromptSubmit', {
        input: { prompt: input },
        turnId: String(session.turns),
      });
      const hookHints = (promptHook.results || [])
        .map(r => r.parsed?.feedback)
        .filter(Boolean)
        .map(text => ({ source: 'hook', kind: 'feedback', text, ttl_turns: 1, priority: 'medium' }));
      const rejectionHints = (approval.consumeRejectionHints?.() || [])
        .map(h => ({
          source: 'hitl',
          kind: 'approval_rejection',
          text: `${h.decision === 'replan' ? 'User requested a re-plan' : 'User rejected approval'} for ${h.tool}. ${h.note ? `Reason: ${h.note}` : h.reason}. Adjust the approach before retrying.`,
          ttl_turns: 1,
          priority: 'high',
        }));
      latestEnvelope = buildContextEnvelope({
        cwd: safeCwd(),
        effectivePolicy,
        projectContext: latestProjectContext,
        activeHints: [...hookHints, ...rejectionHints],
        projectResources,
        agentContext: toolExecutor.getAgentContext(),
      });
      ctx.effectivePolicy = effectivePolicy;
      ctx.latestProjectContext = latestProjectContext;
      ctx.latestEnvelope = latestEnvelope;
      Object.assign(execContext, latestEnvelope);
      if (skipPerms) execContext.freeswim = true;
      // PRD-071: seed work_scope from CLI so the backend has a byte-stable
      // scope block from turn 1. Uses projectResources already gathered by
      // the envelope above.
      execContext.work_scope = buildWorkScope({
        instruction: input,
        cwd: safeCwd(),
        projectResources,
      });
      for (const file of latestProjectContext.changed || []) {
        if (effectivePolicy.policy.context?.showReloadNotice) {
          process.stderr.write(`  ${c.dim(`[Context] ${file.label} updated — re-read`)}\n`);
        }
      }

      for await (const event of client.execute(input, execContext, session.agentHistory)) {
        jsonlWriter.writeKeplerEvent(event);
        if (event.type === 'plan_created' || event.type === 'goal_created') {
          persistProjectArtifacts(
            event.data,
            toolExecutor.getProjectResources(),
            message => process.stderr.write(`  ${c.dim(message)}\n`),
          );
        }
        renderEvent(event);

        if (event.type === 'content_partial') {
          const text = event.data?.text || '';
          assistantContent += text;
          jsonlWriter.accumulateContent(text);
        } else if (event.type === 'content') {
          const text = event.data?.text || '';
          const newText = assistantContent && text.startsWith(assistantContent)
            ? text.slice(assistantContent.length)
            : text === assistantContent ? '' : text;
          if (text) {
            assistantContent = assistantContent && !text.startsWith(assistantContent)
              ? assistantContent + text
              : text;
          }
          if (newText) jsonlWriter.accumulateContent(newText);
        }

        // Local JSONL: capture session ID from backend
        if (event.type === 'session_info' && event.data?.session_id) {
          jsonlWriter.setSessionId(event.data.session_id);
          hookRunner.sessionId = event.data.session_id;
          writeCurrentUserTurn();
        }

        // Local JSONL: accumulate tool calls
        if (event.type === 'tool_call' || event.type === 'tool_request') {
          const d = event.data || {};
          jsonlWriter.accumulateToolCall(d.call_id || d.request_id, d.tool, d.args);
        }

        // Local JSONL: record tool results
        if (event.type === 'tool_done' || event.type === 'tool_result') {
          const d = event.data || {};
          jsonlWriter.recordToolResult(d.call_id || d._callId, d.output, d.success === false);
        }

        // Local JSONL: flush assistant turn on complete
        if (event.type === 'complete') {
          jsonlWriter.setTurnUsage(event.data?.usage, session.model);
          jsonlWriter.flushAssistantTurn();
        }
      }

      flushContent();
    } catch (err) {
      inPlace('');
      flushContent();
      process.stderr.write(`  ${c.red('Error: ' + err.message)}\n`);
    } finally {
      // Clean up execution keypress listener
      if (keypressCleanup) keypressCleanup();
    }

    if (assistantContent) {
      const assistantMessage = { role: 'assistant', content: assistantContent };
      session.history.push(assistantMessage);
      session.agentHistory.push(assistantMessage);
    }

    showPrompt();
  }

  rl.on('close', async () => {
    stopSpinner();
    await hookRunner.run('Stop', { input: { session_id: session.id || '' } });
    await jsonlWriter.close();
    process.stderr.write(`\n  ${c.dim('session ended')}\n\n`);
    process.exit(0);
  });
}
