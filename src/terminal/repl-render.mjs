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
 *   - Detail expansion (/last, /expand N, Ctrl+D)
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
import {
  clearPinnedStatus,
  drawPinnedStatus,
  isInputDockMounted,
  moveToContent,
} from '../ui/input-dock.mjs';
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

export function renderExploreRun() {
  // Set the lock BEFORE touching the spinner so the interval's next tick
  // picks up exploreSummary() text instead of any stale label.
  runtime.exploreRun.lineActive = true;

  // Paint the pinned line immediately so the user sees the update from
  // the very first tool call, not after the 80 ms interval delay.
  if (isInputDockMounted()) {
    const frame = SPIN_FRAMES[runtime.spinFrame % SPIN_FRAMES.length];
    drawPinnedStatus(`  ${c.brand(frame)} ${c.dim(exploreSummary())}`);
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
      if (isExploreActive && isInputDockMounted() && drawPinnedStatus(rendered)) {
        return;
      }
      if (isInputDockMounted()) moveToContent();
      inPlace(rendered);
    }, 80);
  }
  runtime.lastRenderedBlock = 'tool';
}

export function flushExploreRun() {
  const total = Object.values(runtime.exploreRun.counts).reduce((a, b) => a + b, 0);
  // Release the lock first so the real spinner teardown can run.
  const wasActive = runtime.exploreRun.lineActive;
  runtime.exploreRun.lineActive = false;
  if (total > 0) {
    if (wasActive) {
      if (runtime.spinInterval) { clearInterval(runtime.spinInterval); runtime.spinInterval = null; }
      runtime.spinText = '';
      // Clear the pinned status row instead of using inPlace (which is
      // unreliable near the bottom of the scroll region).
      if (isInputDockMounted()) clearPinnedStatus();
    }
    const cols = process.stderr.columns || 120;
    const line = `  ${paint.text.dim(fitAnsiLine(exploreSummary(), Math.max(32, cols - 2)))}`;
    process.stderr.write(`${line}\n`);
    runtime.lastRenderedBlock = 'tool';
  }
  runtime.exploreRun = { counts: {}, recent: [], lineActive: false };
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
  // Spinner shows what's running until the result arrives.
  startSpinner(`${tool}…`);
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

  // ── Single-line combined emit ──
  // If the head for this call is still buffered (no interleaving content
  // landed), and the combined line fits the terminal width, emit ONE line
  // and skip the gutter entirely.
  if (runtime.pendingHead && runtime.pendingHead.callId === callId && !hasLint && !runtime.pendingHead.head.includes('\n')) {
    const cols = process.stderr.columns || 120;
    const combined = `${runtime.pendingHead.head}  ${outcome}`;
    if (stripAnsi(combined).length <= cols) {
      process.stderr.write(`${combined}\n`);
      if (diffPreview) process.stderr.write(`${diffPreview}\n`);
      runtime.lastRenderedBlock = 'tool';
      runtime.pendingHead = null;
      return;
    }
    if (isInlineOutcomeTool(tool)) {
      const compactHead = compactHeadForOutcome(runtime.pendingHead.head, outcome, cols);
      process.stderr.write(`${compactHead}  ${outcome}\n`);
      if (diffPreview) process.stderr.write(`${diffPreview}\n`);
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
  process.stderr.write(`${gutter}${outcome}\n`);
  if (diffPreview) process.stderr.write(`${diffPreview}\n`);
  runtime.lastRenderedBlock = 'tool';

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

export function startSpinner(text) {
  runtime.spinText = text;
  runtime.spinFrame = 0;
  if (runtime.spinInterval) return; // already running
  runtime.spinInterval = setInterval(() => {
    // While an explore run is active, its live counts own the spinner
    // line — re-fetch on every tick so the text stays current no matter
    // which handler happened to call startSpinner/updateSpinner last.
    const isExploreActive = runtime.exploreRun && runtime.exploreRun.lineActive;
    const label = isExploreActive ? exploreSummary() : runtime.spinText;
    if (!label) return;
    const frame = SPIN_FRAMES[runtime.spinFrame % SPIN_FRAMES.length];
    runtime.spinFrame++;
    const rendered = `  ${c.brand(frame)} ${c.dim(label)}`;
    // Explore uses ABSOLUTE cursor positioning to a pinned row inside the
    // content region. inPlace()'s _lastLineCount-based approach stacks copies
    // of the line into scrollback whenever a '\n' at the region's bottom row
    // triggers a scroll — absolute positioning + clear-line is immune.
    if (isExploreActive && isInputDockMounted() && drawPinnedStatus(rendered)) {
      return;
    }
    if (isInputDockMounted()) moveToContent();
    inPlace(rendered);
  }, 80);
}

export function updateSpinner(text) {
  runtime.spinText = text;
}

export function stopSpinner() {
  // Explore owns the line while active — a stray stopSpinner from a
  // transient handler must not blank the progress feedback.
  // flushExploreRun() releases the lock and does the real teardown.
  if (runtime.exploreRun && runtime.exploreRun.lineActive) return;
  if (runtime.spinInterval) { clearInterval(runtime.spinInterval); runtime.spinInterval = null; }
  runtime.spinText = '';
  if (isInputDockMounted()) moveToContent();
  inPlace('');
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
  runtime.exploreRun = { counts: {}, recent: [], lineActive: false };
  runtime.renderedContentThisTurn = false;
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

  if (isInputDockMounted()) moveToContent();
  stopSpinner();
  // Any buffered tool head needs to land BEFORE this content so the order
  // is preserved on screen.
  flushPendingHead();
  flushCompactReadRun();
  renderBlockBoundary('content');
  const rendered = renderMarkdown(runtime.streamBuffer);
  for (const line of rendered.split('\n')) {
    process.stdout.write(`  ${line}\n`);
  }
  runtime.streamBuffer = '';
  runtime.renderedContentThisTurn = true;
  runtime.lastRenderedBlock = 'content';
  if (typeof runtime.afterContentFlush === 'function') runtime.afterContentFlush();
}

export function renderStagnation(data = {}) {
  const rawMessage = data?.message || '';
  const reason = data?.reason || rawMessage.replace(/^Stagnation:\s*/i, '').trim();
  const tool = data?.tool || data?.tool_name || '';
  const suggestion = data?.suggestion || data?.recovery_strategy || data?.strategy || '';
  const message = reason
    ? `Stagnation${tool ? ` (${tool})` : ''}: ${reason}`
    : `Stagnation${tool ? ` (${tool})` : ''} detected`;
  const key = `${message}\n${suggestion}`;

  if (session._lastStagnationWarning === key) return;
  session._lastStagnationWarning = key;

  stopSpinner();
  flushContent();
  flushPendingHead();
  renderBlockBoundary('status', { compactSame: true });
  process.stderr.write(`  ${c.yellow('!')} ${c.yellow(message)}\n`);
  if (suggestion) process.stderr.write(`    ${c.dim(suggestion)}\n`);
  runtime.lastRenderedBlock = 'status';
}
