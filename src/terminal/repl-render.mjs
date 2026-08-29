/**
 * REPL rendering pipeline — event-facing side.
 *
 * Extracted from repl.mjs. Contains the pieces that write to the terminal
 * once an event has been dispatched:
 *   - Block boundaries between different display sections
 *   - Tool head + result rendering (single-line vs two-line card shape)
 *   - Explore-run collapse (list/read/search/index burst → one animated line)
 *   - Content streaming (SSE partials → debounced markdown flush)
 *   - Spinner (single animated line, shared across concerns)
 *   - Stagnation banner
 *   - Detail expansion (/last, /expand N, F2)
 *
 * All mutable state lives in repl-state.mjs (`runtime`). Consumers of this
 * module (renderEvent, handleCommand, keypress handlers) import the specific
 * functions they need.
 */

import { c, stripAnsi, renderMarkdown, inPlace } from './ansi.mjs';
import { paint } from '../ui/palette.mjs';
import { runtime, session } from './repl-state.mjs';
import { fitAnsiLine } from './repl-format.mjs';
import { exploreCategory, isExploreTool } from './repl-explore.mjs';
import { watchState } from './watch-state.mjs';
import {
  clearPinnedStatus,
  drawPinnedStatus,
  isInputDockMounted,
  moveToContent,
} from '../ui/input-dock.mjs';
import * as queue from '../ui/render-queue.mjs';

// Single seam for the transient spinner/status line. Rich mode (render
// queue active) → coalesced last-wins status that can never interleave
// with content. Legacy dock path and bare-TTY inPlace stay as fallbacks
// until their write-sites migrate onto the queue too.
// Max inner-tool lines shown under the spinner during a sub-agent run.
const SUB_AGENT_WINDOW_ROWS = 7;

function statusWidth() {
  return Math.max(8, (process.stderr.columns || process.stdout.columns || 120) - 1);
}

function fitStatusLine(line) {
  return fitAnsiLine(String(line ?? '').replace(/[\r\n]+/g, ' '), statusWidth());
}

function fitStatusLines(lines) {
  return (Array.isArray(lines) ? lines : [lines]).map(fitStatusLine);
}

function presentStatus(rendered) {
  // Watch panel override: when active, render the watch panel entries as a
  // multi-line status block instead of the normal spinner/status line.
  if (watchState.active) {
    const lines = watchState.visible();
    if (lines.length) {
      const fitted = fitStatusLines(lines);
      if (queue.isActive()) {
        queue.statusBlock(fitted);
      } else if (isInputDockMounted()) {
        drawPinnedStatus(fitted.join('\n'));
      } else {
        inPlace(fitted.join('\n'));
      }
      return;
    }
  }
  const fitted = fitStatusLine(rendered);
  if (queue.isActive()) {
    const win = runtime.subAgentWindow;
    if (win?.active && win.lines.length) {
      queue.statusBlock([
        fitted,
        ...fitStatusLines(win.lines.slice(-SUB_AGENT_WINDOW_ROWS).map(l => `    ${c.dim(l)}`)),
      ]);
      return;
    }
    queue.status(fitted);
    return;
  }
  if (isInputDockMounted()) { drawPinnedStatus(fitted); return; }
  inPlace(fitted);
}

/** Push a line into the live sub-agent tool window (dedup consecutive). */
export function pushSubAgentWindowLine(line) {
  const win = runtime.subAgentWindow;
  if (!win?.active) return;
  const text = String(line || '').trim();
  if (!text || win.lines[win.lines.length - 1] === text) return;
  win.lines.push(text);
  if (win.lines.length > 24) win.lines.splice(0, win.lines.length - 24);
  repaintSpinnerStatus();
}

export function setSubAgentWindowActive(active) {
  runtime.subAgentWindow = { active: Boolean(active), lines: [] };
}

/**
 * Replace the entire sub-agent live window with these lines. Called by
 * repl.mjs's fold-* functions on every sub-agent tool_call and tool_result
 * so the window shows RICH per-tool progress (same '• tool — outcome'
 * format as the final summary) live during the sub-agent run instead of
 * a bare '→ tool' spinner text or nothing at all.
 */
export function rebuildSubAgentWindow(lines) {
  const win = runtime.subAgentWindow;
  if (!win?.active) return;
  win.lines = Array.isArray(lines) ? lines.slice() : [];
  repaintSpinnerStatus();
}

function erasePresentedStatus() {
  if (queue.isActive()) { queue.clearStatus(); return; }
  if (isInputDockMounted()) { clearPinnedStatus(); moveToContent(); return; }
  inPlace('');
}
import {
  formatCardHead,
  formatCompactFileDiff,
  summarizeResult,
  recordCard,
  lastCard,
  getCard,
  allCards,
  clearCards,
} from '../ui/tool-card.mjs';
import { detailFor } from '../ui/tool-details.mjs';
import { subAgentIndent, inSubAgent as inSubAgentBlock } from '../ui/sub-agent.mjs';
import { safeCwd } from './repl-utils.mjs';
import { transcriptHeader, transcriptLine } from '../ui/transcript-block.mjs';

export function blockSeparatorMode() {
  return String(process.env.KEPLER_BLOCK_SEPARATOR || 'space').toLowerCase();
}

export function renderBlockBoundary(nextBlock, { compactSame = false } = {}) {
  if (!runtime.lastRenderedBlock) return;
  if (compactSame && runtime.lastRenderedBlock === nextBlock) return;

  const mode = blockSeparatorMode();
  if (mode === 'off' || mode === 'none') return;
  if (mode === 'dotted' || mode === 'dots') {
    const cols = Math.max(24, process.stderr.columns || process.stdout.columns || 80);
    process.stderr.write(`  ${c.dim('·'.repeat(Math.min(44, cols - 4)))}\n`);
    return;
  }

  process.stderr.write('\n');
}

export function flushPendingHead() {
  if (!runtime.pendingHead) return;
  process.stderr.write(`${runtime.pendingHead.head}\n`);
  runtime.lastRenderedBlock = 'tool';
  runtime.pendingHead = null;
}

export function clearPendingHead() {
  // Called by interleaving handlers — flush as 2-line shape (because we are
  // about to print something else) and continue.
  flushPendingHead();
}

export function isInlineOutcomeTool(tool) {
  return [
    'read_file', 'read_files', 'read_batch', 'get_file_info',
    'search_code', 'search_files', 'grep', 'list_files',
  ].includes(String(tool || '').toLowerCase());
}

export function compactHeadForOutcome(head, outcome, cols) {
  const reserve = stripAnsi(outcome).length + 4;
  const maxHead = Math.max(28, cols - reserve);
  return fitAnsiLine(head, maxHead);
}

export function readToolLabel(tool, data = {}) {
  const args = data.args || {};
  const filePath = args.file_path || args.path || data.file_path || data.path
    || args.pattern || args.query || '';
  if (filePath) return shortPath(String(filePath));
  const output = String(data.output_preview || data.output || '').split('\n').find(Boolean) || '';
  const match = output.match(/^([^:\s][^:\n]*):/);
  return match ? shortPath(match[1]) : String(tool || 'file');
}

export function rememberExplore(label) {
  const value = String(label || '').trim();
  if (!value) return;
  runtime.exploreRun.recent.push(value);
  if (runtime.exploreRun.recent.length > 3) runtime.exploreRun.recent.shift();
}

export function exploreSummary() {
  const { counts, recent } = runtime.exploreRun;
  const bits = [];
  if (counts.list)   bits.push(`${counts.list} listed`);
  if (counts.read)   bits.push(`${counts.read} read`);
  if (counts.search) bits.push(`${counts.search} searched`);
  if (counts.index)  bits.push(`${counts.index} indexed`);
  const stats = bits.length ? bits.join(' · ') : 'starting…';
  const latest = recent.length ? ` · ${recent[recent.length - 1]}` : '';
  return `exploring · ${stats}${latest}`;
}

function exploreRunTotal() {
  return Object.values(runtime.exploreRun.counts).reduce((a, b) => a + b, 0);
}

function exploreSnapshotEvery() {
  const n = Number.parseInt(process.env.KEPLER_EXPLORE_SNAPSHOT_EVERY || '8', 10);
  return Number.isFinite(n) ? Math.max(1, n) : 8;
}

function exploreSnapshotMs() {
  const n = Number.parseInt(process.env.KEPLER_EXPLORE_SNAPSHOT_MS || '900', 10);
  return Number.isFinite(n) ? Math.max(100, n) : 900;
}

function writeExploreSnapshot(summary = exploreSummary()) {
  const cols = process.stderr.columns || 120;
  const line = `  ${paint.text.dim(fitAnsiLine(summary, Math.max(32, cols - 2)))}`;
  process.stderr.write(`${line}\n`);
  runtime.exploreRun.lastPrintedSummary = summary;
  runtime.exploreRun.lastPrintedTotal = exploreRunTotal();
  runtime.exploreRun.lastPrintedAt = Date.now();
  runtime.lastRenderedBlock = 'tool';
}

function shouldPrintExploreSnapshot() {
  const summary = exploreSummary();
  const total = exploreRunTotal();
  if (!summary || total <= 0) return false;
  if (!runtime.exploreRun.lastPrintedSummary) return true;
  if (summary === runtime.exploreRun.lastPrintedSummary) return false;

  const sinceTotal = total - (runtime.exploreRun.lastPrintedTotal || 0);
  const sinceMs = Date.now() - (runtime.exploreRun.lastPrintedAt || 0);
  return sinceTotal >= exploreSnapshotEvery() || sinceMs >= exploreSnapshotMs();
}

export function renderExploreRun() {
  // Set the lock BEFORE touching the spinner so the interval's next tick
  // picks up exploreSummary() text instead of any stale label.
  runtime.exploreRun.lineActive = true;

  if (!queue.isActive() && isInputDockMounted()) {
    // Legacy docked path (queue not engaged): an animated bottom overlay
    // created visible gaps, so emit bounded snapshots into the transcript
    // instead. With the render queue active this branch is skipped — the
    // coalesced status line can animate safely in dock mode.
    if (runtime.spinInterval) {
      clearInterval(runtime.spinInterval);
      runtime.spinInterval = null;
      inPlace('');
    }
    runtime.spinText = '';
    if (shouldPrintExploreSnapshot()) writeExploreSnapshot();
    return;
  }

  if (!runtime.spinInterval) {
    // Bypass the lockout in startSpinner by seeding runtime.spinText directly.
    runtime.spinText = exploreSummary();
    runtime.spinFrame = 0;
    runtime.spinInterval = setInterval(() => {
      const isExploreActive = runtime.exploreRun && runtime.exploreRun.lineActive;
      const label = isExploreActive ? exploreSummary() : runtime.spinText;
      if (!label) return;
      const frame = SPIN_FRAMES[runtime.spinFrame % SPIN_FRAMES.length];
      runtime.spinFrame++;
      const rendered = `  ${c.brand(frame)} ${c.dim(label)}`;
      presentStatus(rendered);
    }, 80);
  }
  runtime.lastRenderedBlock = 'tool';
}

export function flushExploreRun() {
  const total = exploreRunTotal();
  const summary = exploreSummary();
  // Release the lock first so the real spinner teardown can run.
  const wasActive = runtime.exploreRun.lineActive;
  runtime.exploreRun.lineActive = false;
  if (total > 0) {
    if (wasActive) {
      if (runtime.spinInterval) { clearInterval(runtime.spinInterval); runtime.spinInterval = null; }
      runtime.spinText = '';
      if (queue.isActive()) queue.clearStatus();
      else if (!isInputDockMounted()) inPlace('');
    }
    if (queue.isActive() || !isInputDockMounted() || summary !== runtime.exploreRun.lastPrintedSummary) {
      writeExploreSnapshot(summary);
    }
  }
  runtime.exploreRun = { counts: {}, recent: [], lineActive: false, lastPrintedSummary: '', lastPrintedTotal: 0, lastPrintedAt: 0 };
}

// Legacy alias — several sites (resetContentStream, older event handlers)
// call this. Keep pointing at the new flush so nothing has to change.
const flushCompactReadRun = flushExploreRun;

export function renderToolCall(data) {
  const tool = data?.tool || 'unknown';
  const args = data?.args || {};
  const indent = subAgentIndent();
  const callId = data?.call_id || data?._callId || `${tool}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If a previous head is still pending (no result yet), flush it as a
  // regular two-line shape before starting the next one.
  flushPendingHead();

  // ── Explore-run collapse ────────────────────────────────────────────────
  // For list/read/search/index tools, skip the per-call head entirely and
  // update a single animated summary spinner. The transcript stays clean;
  // the user still sees live progress (12 read · 3 listed · latest: foo.py).
  if (isExploreTool(tool)) {
    runtime.exploreRun.counts[exploreCategory(tool)] =
      (runtime.exploreRun.counts[exploreCategory(tool)] || 0) + 1;
    session.toolCounts[tool] = (session.toolCounts[tool] || 0) + 1;
    const label = readToolLabel(tool, { args });
    if (label) rememberExplore(label);
    recordCard({ id: callId, tool, args, startedAt: Date.now() });
    renderExploreRun();
    return;
  }

  // Sub-agent live window (queue mode): inner tool calls stream into the
  // fixed-height status block instead of appending transcript lines. The
  // card is still recorded so /expand, /last, and `d` show full detail.
  if (queue.isActive() && runtime.subAgentWindow?.active && inSubAgentBlock()) {
    recordCard({ id: callId, tool, args, startedAt: Date.now() });
    session.toolCounts[tool] = (session.toolCounts[tool] || 0) + 1;
    const label = readToolLabel(tool, { args });
    pushSubAgentWindowLine(label ? `→ ${tool} · ${label}` : `→ ${tool}`);
    return; // the spinner tick paints the window block
  }

  flushExploreRun();
  renderBlockBoundary('tool', { compactSame: tool !== 'shell' });

  const head = formatCardHead(tool, args, {
    cwd: safeCwd(),
    columns: process.stderr.columns || 120,
    indent,
  });

  recordCard({ id: callId, tool, args, head, startedAt: Date.now() });
  session.toolCounts[tool] = (session.toolCounts[tool] || 0) + 1;
  runtime.pendingHead = { callId, head, indent };
  runtime.lastRenderedBlock = 'tool';
  // Spinner shows what's running until the result arrives. Per-call phase
  // gives each tool its own elapsed clock — long shell runs count up live.
  const spinLabel = tool === 'shell' && args.command
    ? `shell: ${String(args.command).split('\n')[0].slice(0, 48)}`
    : `${tool}…`;
  startSpinner(spinLabel, { phase: `tool:${callId}` });
}

/**
 * Render a tool result (success/failure, output snippet).
 */
// (declaration moved to repl-state.mjs runtime.*)

export function formatToolDuration(data) {
  const ms = data?.duration_ms ?? (data?.duration_s != null ? data.duration_s * 1000 : null);
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function renderToolResult(data, eventType = 'tool_result') {
  if (!data) return;
  const indent = subAgentIndent();
  const gutter = `${indent}${paint.text.dim('⎿')}  `;
  const callId = data.call_id || data._callId;
  // Either tool_result or tool_done is allowed to render — whichever wins
  // the race. Subsequent events for the same callId are duplicates.
  if (callId && runtime.renderedToolResults.has(callId)) return;
  if (callId) runtime.renderedToolResults.add(callId);

  const tool = data.tool || data._tool || '';
  const durationMs = data?.duration_ms ?? (data?.duration_s != null ? data.duration_s * 1000 : null);
  recordReadActivity(tool, data.args || {});
  recordWriteActivity(tool, data.args || {}, data);

  // Update the card buffer so /last and `d` can find it.
  if (callId) recordCard({ id: callId, tool, args: data.args, result: data, durationMs });

  if (data._blocked) session.blockedOps++;

  const { text, tone: t } = summarizeResult(tool, data, data.args || {});
  // Em dash reads more like prose than a system arrow.
  const arrow = shellResultTool(tool)
    ? `${paint.text.dim('result')} ${paint.text.dim('—')}`
    : paint.text.dim('—');
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
  const diffPreview = formatCompactFileDiff(data, {
    indent: gutter,
    columns: process.stderr.columns || 120,
  });

  // Explore tools: the call already updated the summary spinner. Refresh
  // the "latest" hint with the result's file if we have one, and skip the
  // per-result render entirely.
  if (isExploreTool(tool)) {
    const label = readToolLabel(tool, data);
    if (label) rememberExplore(label);
    renderExploreRun();
    return;
  }

  // Sub-agent live window: the call line is already streaming in the
  // status block; the result stays card-only (close card summarizes).
  if (queue.isActive() && runtime.subAgentWindow?.active && inSubAgentBlock()) {
    return;
  }

  // ── Single-line combined emit ──
  // If the head for this call is still buffered (no interleaving content
  // landed), and the combined line fits the terminal width, emit ONE line
  // and skip the gutter entirely. Multi-line result text (shell preview
  // with rows + "+ N more" tail) skips this path — a wrapped multi-line
  // block needs its own real estate.
  const outcomeIsMultiLine = outcome.includes('\n');
  if (runtime.pendingHead && runtime.pendingHead.callId === callId && !hasLint && !runtime.pendingHead.head.includes('\n') && !outcomeIsMultiLine) {
    const cols = process.stderr.columns || 120;
    const combined = `${runtime.pendingHead.head}  ${outcome}`;
    if (stripAnsi(combined).length <= cols) {
      process.stderr.write(`${combined}\n`);
      if (diffPreview) {
        process.stderr.write(`${diffPreview}\n`);
        rememberFileDiffPreview(data);
      }
      renderPlanBody(tool, data);
      runtime.lastRenderedBlock = 'tool';
      runtime.pendingHead = null;
      return;
    }
    if (isInlineOutcomeTool(tool)) {
      const compactHead = compactHeadForOutcome(runtime.pendingHead.head, outcome, cols);
      process.stderr.write(`${compactHead}  ${outcome}\n`);
      if (diffPreview) {
        process.stderr.write(`${diffPreview}\n`);
        rememberFileDiffPreview(data);
      }
      renderPlanBody(tool, data);
      runtime.lastRenderedBlock = 'tool';
      runtime.pendingHead = null;
      return;
    }
    // Combined too wide — flush the head as 2-line and fall through.
    flushPendingHead();
  } else if (runtime.pendingHead) {
    // Stale pending head (different callId) — flush it before printing this
    // result's gutter line below.
    flushPendingHead();
  }

  // Two-line shape: gutter under the (already-printed or just-flushed) head.
  // Multi-line outcome (shell preview with rows + "+ N more" tail): prepend
  // the gutter to each line so the block stays aligned instead of ragged.
  if (outcomeIsMultiLine) {
    for (const line of outcome.split('\n')) {
      process.stderr.write(`${gutter}${line}\n`);
    }
  } else {
    process.stderr.write(`${gutter}${outcome}\n`);
  }
  if (diffPreview) {
    process.stderr.write(`${diffPreview}\n`);
    rememberFileDiffPreview(data);
  }
  renderPlanBody(tool, data);
  runtime.lastRenderedBlock = 'tool';

  // Lint warnings stay visible alongside writes.
  if (hasLint) {
    process.stderr.write(`${gutter}${paint.state.warn('⚠ ' + String(data.lint).split('\n')[0].slice(0, 80))}\n`);
  }
}

// The plan sub-agent's output is the one peer result the USER needs to
// see, not just the model — it's the execution contract for the turn.
// Render the body as a bordered block (capped; full text stays on the
// card via /last). All other peer verbs keep the one-line summary.
const PLAN_BODY_MAX_LINES = 30;

function renderPlanBody(tool, data) {
  if (String(tool || '').toLowerCase() !== 'plan') return;
  const text = String(data?.output ?? data?.result ?? '').trim();
  if (!text) return;
  const indent = subAgentIndent();
  const lines = transcriptRenderableLines(renderMarkdown(text));
  if (!lines.length) return;
  const shown = lines.slice(0, PLAN_BODY_MAX_LINES);
  process.stderr.write(`${indent}${paint.text.dim('┌ plan')}\n`);
  for (const line of shown) {
    process.stderr.write(`${indent}${paint.text.dim('│')} ${line}\n`);
  }
  process.stderr.write(lines.length > shown.length
    ? `${indent}${paint.text.dim(`└ … ${lines.length - shown.length} more lines · /last to expand`)}\n`
    : `${indent}${paint.text.dim('└')}\n`);
}

function fileDiffKey(data = {}) {
  return fileDiffKeys(data)[0] || '';
}

function fileDiffKeys(data = {}) {
  const keys = [];
  const callId = data.call_id || data._callId || data.request_id || data.id;
  if (callId) keys.push(`call:${callId}`);
  const diff = Array.isArray(data.file_diffs) ? data.file_diffs[0]
    : data.file_diff ? data.file_diff
    : data.type === 'file_diff' ? data
    : null;
  const file = diff?.relative_path || diff?.path || data.relative_path || data.path || '';
  if (file) {
    const added = diff?.lines_added ?? data.lines_added ?? '';
    const removed = diff?.lines_removed ?? data.lines_removed ?? '';
    keys.push(`file:${file}:${added}:${removed}`);
  }
  return keys;
}

function rememberFileDiffPreview(data = {}) {
  for (const key of fileDiffKeys(data)) {
    runtime.renderedFileDiffPreviews.add(key);
  }
}

export function renderFileDiffEvent(data = {}) {
  const keys = fileDiffKeys(data);
  if (keys.some(key => runtime.renderedFileDiffPreviews.has(key))) return false;

  const indent = subAgentIndent();
  const gutter = `${indent}${paint.text.dim('⎿')}  `;
  const diffPreview = formatCompactFileDiff({
    file_diff: data,
    lines_added: data.lines_added,
    lines_removed: data.lines_removed,
  }, {
    indent: gutter,
    columns: process.stderr.columns || 120,
    showFileHeader: true,
  });
  if (!diffPreview) return false;

  renderBlockBoundary('tool', { compactSame: true });
  process.stderr.write(`${diffPreview}\n`);
  for (const key of keys) runtime.renderedFileDiffPreviews.add(key);
  rememberChangedFile(data.relative_path || data.path);
  runtime.lastRenderedBlock = 'tool';
  return true;
}

function shellResultTool(tool) {
  return [
    'shell', 'run_tests', 'validate_build', 'lint_check',
    'validate_file', 'validate_structure',
  ].includes(String(tool || '').toLowerCase());
}

// ── Expand handler — `d`, `/last`, `/expand` ───────────────────────────
//
// All three call into the same renderer so output is consistent across
// keypress and slash-command paths. `expandLast` and `expandIndex` write
// directly to stderr.

export function expandLast() {
  const card = lastCard();
  if (!card) {
    process.stderr.write(`  ${paint.text.dim('(no tool to expand yet)')}\n`);
    return;
  }
  process.stderr.write('\n' + detailFor(card) + '\n\n');
}

export function expandIndex(idxOrAll) {
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
export function shortPath(p) {
  if (!p) return '';
  const cwd = safeCwd();
  if (p.startsWith(cwd)) return p.slice(cwd.length + 1);
  // Show last 2 segments
  const parts = p.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
}

export function rememberReadFile(filePath) {
  const file = shortPath(String(filePath || '').trim());
  if (file && !session.filesRead.includes(file)) session.filesRead.push(file);
}

export function rememberChangedFile(filePath) {
  const file = shortPath(String(filePath || '').trim());
  if (file && !session.filesChanged.includes(file)) session.filesChanged.push(file);
}

export function recordReadActivity(tool, args = {}) {
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

export function recordWriteActivity(tool, args = {}, result = {}) {
  const normalized = String(tool || '').toLowerCase();
  if (!['write_file', 'edit_file', 'delete_file', 'write_project'].includes(normalized)) return;

  if (normalized === 'write_project') {
    const files = Array.isArray(args.files) ? args.files : [];
    for (const file of files) {
      rememberChangedFile(file?.file_path || file?.path);
    }
  }

  rememberChangedFile(args.file_path || args.path || result.file_path || result.path);
  const diffs = Array.isArray(result.file_diffs)
    ? result.file_diffs
    : result.file_diff ? [result.file_diff] : [];
  for (const diff of diffs) {
    rememberChangedFile(diff.relative_path || diff.path);
  }
}

export function thinkingKind(text) {
  return /\b(read|reading|inspect|scan|search|open|trace|look(?:ing)?\s+at)\b/i.test(text)
    ? 'Reading'
    : 'Thinking';
}

export function thinkingPrefix(text) {
  const kind = thinkingKind(text);
  return kind === 'Thinking' ? 'Thinking' : `Thinking · ${kind}`;
}

export function clippedThinking(text, limit = 200) {
  const value = String(text || '');
  return value.length > limit ? `${value.slice(0, limit - 2)} …` : value;
}

// ── Live Spinner ──
// A real animated spinner that ticks on an interval, not just per-call.
// Shows what's happening right now — thinking, tool executing, etc.

export const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// (declaration moved to repl-state.mjs runtime.*)
// (declaration moved to repl-state.mjs runtime.*)
// (declaration moved to repl-state.mjs runtime.*)

// Compose the status label with live phase telemetry: elapsed seconds
// (shown once a phase runs ≥3s — quick tools stay clean) and the
// per-phase tool-call counter (sub-agent progress). The 80ms tick calls
// this every frame, so elapsed counts up without any extra timer.
function composeStatusLabel(label) {
  const parts = [label];
  if (runtime.spinStartedAt) {
    const elapsedS = Math.floor((Date.now() - runtime.spinStartedAt) / 1000);
    if (runtime.spinToolCalls > 0) {
      parts.push(`${runtime.spinToolCalls} call${runtime.spinToolCalls === 1 ? '' : 's'}`);
    }
    if (elapsedS >= 3) parts.push(`${elapsedS}s`);
  }
  return parts.join(' · ');
}

export function repaintSpinnerStatus(text = runtime.spinText, { advance = false } = {}) {
  const isExploreActive = runtime.exploreRun && runtime.exploreRun.lineActive;
  const label = isExploreActive ? exploreSummary() : (text || runtime.spinText);
  if (!label) return;
  const frame = SPIN_FRAMES[runtime.spinFrame % SPIN_FRAMES.length];
  if (advance) runtime.spinFrame++;
  const rendered = `  ${c.brand(frame)} ${c.dim(composeStatusLabel(label))}`;
  if (!queue.isActive() && isExploreActive && isInputDockMounted()) return;
  presentStatus(rendered);
}

/**
 * Start (or re-label) the spinner. `phase` scopes the elapsed clock:
 * a phase change resets it, same-phase updates keep it counting. Callers
 * that don't pass a phase get a generic per-call reset (old behavior).
 */
export function startSpinner(text, { phase = null } = {}) {
  const nextPhase = phase || `generic:${text}`;
  if (runtime.spinPhase !== nextPhase) {
    runtime.spinPhase = nextPhase;
    runtime.spinStartedAt = Date.now();
    runtime.spinToolCalls = 0;
  }
  runtime.spinText = text;
  runtime.spinFrame = 0;
  if (!queue.isActive() && runtime.exploreRun && runtime.exploreRun.lineActive && isInputDockMounted()) return;
  if (runtime.spinInterval) {
    repaintSpinnerStatus(runtime.spinText);
    return; // already running
  }
  runtime.spinInterval = setInterval(() => {
    repaintSpinnerStatus(runtime.spinText, { advance: true });
  }, 80);
  repaintSpinnerStatus(runtime.spinText);
}

export function updateSpinner(text) {
  runtime.spinText = text;
  // Self-healing: a content flush stops the spinner (clears the
  // interval), but long-running work — sub-agent runs especially —
  // keeps sending updates afterwards. Without reviving the interval
  // those updates write into a dead timer and the user sees a frozen
  // "▸ running" with no progress at all. Same phase → clock continues.
  if (!runtime.spinInterval && text) {
    startSpinner(text, { phase: runtime.spinPhase || undefined });
    return;
  }
  repaintSpinnerStatus(runtime.spinText);
}

/** Bump the per-phase progress counter (sub-agent tool calls). */
export function bumpSpinnerProgress() {
  runtime.spinToolCalls++;
}

export function stopSpinner() {
  // Explore owns the line while active — a stray stopSpinner from a
  // transient handler must not blank the progress feedback.
  // flushExploreRun() releases the lock and does the real teardown.
  if (runtime.exploreRun && runtime.exploreRun.lineActive) return;
  if (runtime.spinInterval) { clearInterval(runtime.spinInterval); runtime.spinInterval = null; }
  runtime.spinText = '';
  runtime.spinPhase = null;
  runtime.spinStartedAt = 0;
  runtime.spinToolCalls = 0;
  erasePresentedStatus();
}

// ── Content Streaming Display ──

// (declaration moved to repl-state.mjs runtime.*)
// (declaration moved to repl-state.mjs runtime.*)
// (declaration moved to repl-state.mjs runtime.*)
// (declaration moved to repl-state.mjs runtime.*)
// (declaration moved to repl-state.mjs runtime.*)

export function startContentStream() {
  runtime.streamBuffer = '';
  runtime.streamedPartialText = '';
  runtime.renderedToolResults.clear();
  runtime.renderedFileDiffPreviews.clear();
  runtime.exploreRun = { counts: {}, recent: [], lineActive: false, lastPrintedSummary: '', lastPrintedTotal: 0, lastPrintedAt: 0 };
  runtime.renderedContentThisTurn = false;
  runtime.contentHeaderPrinted = false;
  runtime.lastRenderedBlock = null;
  stopSpinner();
}

export function appendContent(text) {
  if (!text) return;
  // Any streamed content between renderToolCall and renderToolResult would
  // scroll the head off "the line above", breaking the in-place collapse.
  clearPendingHead();
  runtime.streamBuffer += text;
  runtime.streamedPartialText += text;

  // Debounce rendering to avoid flicker on rapid partial updates
  if (runtime.streamTimer) clearTimeout(runtime.streamTimer);
  runtime.streamTimer = setTimeout(() => flushContent(), 50);
}

export function flushContent() {
  if (runtime.streamTimer) { clearTimeout(runtime.streamTimer); runtime.streamTimer = null; }
  if (!runtime.streamBuffer) return;

  const rendered = renderMarkdown(runtime.streamBuffer);
  const lines = transcriptRenderableLines(rendered);
  runtime.streamBuffer = '';
  if (!lines.length) return;

  if (isInputDockMounted()) moveToContent();
  stopSpinner();
  // Any buffered tool head needs to land BEFORE this content so the order
  // is preserved on screen.
  flushPendingHead();
  flushCompactReadRun();
  renderBlockBoundary('content', { compactSame: true });
  if (!runtime.contentHeaderPrinted) {
    process.stdout.write(`${transcriptHeader('bahulam', { tone: 'assistant' })}\n`);
    runtime.contentHeaderPrinted = true;
  }
  for (const line of lines) {
    process.stdout.write(`${transcriptLine(line, { tone: 'assistant' })}\n`);
  }
  runtime.renderedContentThisTurn = true;
  runtime.lastRenderedBlock = 'content';
  if (typeof runtime.afterContentFlush === 'function') runtime.afterContentFlush();
}

export function transcriptRenderableLines(rendered) {
  const lines = String(rendered ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function renderStagnation(data = {}) {
  const rawMessage = data?.message || '';
  const reason = data?.reason || rawMessage.replace(/^Stagnation:\s*/i, '').trim();
  const tool = data?.tool || data?.tool_name || '';
  const count = data?.repeat_count || data?.count || null;
  // Try to extract a target/path from the reason so we can show a
  // compact one-liner. Reason shapes we know about from the framework:
  //   "Repeated overlapping <tool> inspections of '<target>' N times without mutation"
  //   "..."  (fallback: use reason as-is, trimmed to ~80 chars)
  const targetMatch = reason.match(/of\s+['"]([^'"]+)['"]/);
  const target = targetMatch ? targetMatch[1] : '';

  // Compose a compact single-line message:
  //   ! stagnation · read_file × 3 · v3_sse.py
  // Falls back to a short slice of the reason when we can't parse it.
  const parts = ['stagnation'];
  if (tool) parts.push(`${tool}${count ? ` × ${count}` : ''}`);
  if (target) parts.push(target);
  const compact = parts.length > 1 ? parts.join(' · ') : reason.slice(0, 80);

  const key = `${tool}:${target}:${count}`;
  if (session._lastStagnationWarning === key) return;
  session._lastStagnationWarning = key;

  stopSpinner();
  flushContent();
  flushPendingHead();
  renderBlockBoundary('status', { compactSame: true });
  // One line, dim yellow, no follow-up paragraph. The full guidance is
  // still injected into the LLM context on the backend side — no need
  // to also spam the operator's terminal with it.
  process.stderr.write(`  ${c.yellow('!')} ${c.dim(c.yellow(compact))}\n`);
  runtime.lastRenderedBlock = 'status';
}
