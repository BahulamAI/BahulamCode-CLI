/**
 * Resume / session-picker flow.
 *
 * Extracted from repl.mjs. Handles listing previous sessions, previewing
 * one before resuming, mode selection (full / summary / tail-N /
 * checkpoint-full), cwd confirmation, and the /compact runtime.
 *
 * Every function takes an explicit `ctx` for the pieces that only the REPL
 * loop owns (`ctx._rl` readline, `ctx.jsonlWriter`, `ctx.auth`,
 * `ctx.toolExecutor`, `ctx.sessionMgrRef.current`). Shared state (session, orbitRef,
 * safeCwd) is imported directly.
 */

import { c } from './ansi.mjs';
import { session, orbitRef, sessionMgrRef } from './repl-state.mjs';
import { safeCwd } from './repl-utils.mjs';
import { startContentStream, flushContent, stopSpinner } from './repl-render.mjs';
import {
  endStatusMarker,
  filterResumeReplayEvents,
  fitAnsiLine,
  formatRelativeTime,
  formatSessionCost,
  historyRoleLabel,
  mergeResumeReplayItems,
  normalizeResumableSession,
  oneLineInstruction,
  renderHistoryEntries,
  replayStartOrderForMode,
  resumeModeLabel,
  resumeTailTurnCount,
  startResumeProgress,
} from './repl-format.mjs';
import { TarangStreamClient } from '../core/stream-client.mjs';
import { getRecentSessions, getSessionDetail, buildResumeHistory, combineResumeSummaries } from '../core/local-store.mjs';
import { decideResumeMode, projectedTokensForChoice, formatTokens as formatCtxTokens } from '../core/resume-mode.mjs';
import { applyCompactSummary, localCompactSummary, parseCompactTailCount, prepareCompactHistory } from '../core/compact-history.mjs';

export async function listResumableSessions() {
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

export function formatResumeCheckpointStatus(session) {
  const marker = session?.resumeSummary;
  if (!marker || !Number(marker.sourceMessageCount)) return '';
  const full = Number(marker.fullMessageCount) || 0;
  const covered = Number(marker.sourceMessageCount) || 0;
  const pct = full > 0 ? ` ${Math.min(100, Math.round((covered / full) * 100))}%` : '';
  return c.dim(` · summarized${pct}`);
}

export function formatResumeContextStatus(session) {
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

export async function pickResumableSession(resumable, ctx) {
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
export async function chooseThresholdMode(ctx, decision) {
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
      const win = `${formatCtxTokens(decision.windowSize)}${decision.windowKnown ? '' : ' est'}`;
      const lines = [];
      const rawLabel = hasCheckpoint ? 'Raw full transcript would use' : 'This session would use';
      lines.push(`  ${rawLabel}  ${c.brand(`${projected} / ${win}`)} tokens  (${pct}%)`);
      if (!decision.windowKnown) {
        lines.push(`  ${c.dim('Model context window is a CLI fallback estimate; backend/provider limits may differ.')}`);
      }
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

// resumeModeLabel moved to ./repl-format.mjs.

/**
 * PRD-068 §5.14.5 — preview overlay for a session/mode. Read-only, `q` to return.
 * If user hits Enter, resolve to the currently-previewed mode so caller can activate.
 */
export async function previewResumeSession(session, ctx) {
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
          contentLines.push(`${msg.role === 'user' ? c.dim('You:') : c.brand('b0:')} ${String(msg.content).slice(0, 300)}`);
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
export async function confirmCwdSwitch(ctx, savedPath, currentPath) {
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
export async function chooseResumeHistoryMode(ctx, { defaultMode = 'compact' } = {}) {
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

// historyRoleLabel, renderHistoryEntries moved to ./repl-format.mjs.

// `renderResumePreview` needs to replay each transcript event through the
// live event renderer. `renderEvent` still lives in repl.mjs (its extraction
// is a later slice); passing it via `ctx` here avoids a circular import.
export function renderResumePreview(resumed, ctx = {}) {
  const renderEvent = ctx.renderEvent;
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
    const savedOrbit = orbitRef.current;
    const savedSessionMgr = sessionMgrRef.current;
    orbitRef.current = null;
    sessionMgrRef.current = null;
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
      orbitRef.current = savedOrbit;
      sessionMgrRef.current = savedSessionMgr;
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

export async function summarizeResumeTranscript({
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

export async function compactCurrentSession(ctx, rest = '') {
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
