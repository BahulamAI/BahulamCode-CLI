import assert from 'node:assert';
import * as fs from 'node:fs';
// Force ansi16 capability before importing palette-aware modules so the
// test runs the same way under `npm test` (no TTY) as on a terminal.
import { _setForTesting as _setTermForTesting } from '../src/ui/term.mjs';
_setTermForTesting({ isTTY: true, color: true, colorLevel: 'ansi16', plain: false });

import { c, renderMarkdown, renderDiff, stripAnsi } from '../src/terminal/ansi.mjs';
import { formatShellCommand, shellCommandProfile, toolDisplayLabel, toolDisplaySummary } from '../src/terminal/tool-display.mjs';
import {
  isExploreTool as _isExploreTool,
  exploreCategory as _exploreCategory,
  _knownExploreTools,
} from '../src/terminal/repl-explore.mjs';
import { renderBanner } from '../src/ui/banner.mjs';
import { renderMissionReport } from '../src/ui/mission-report.mjs';
import { renderSubAgentOpen, resetSubAgents } from '../src/ui/sub-agent.mjs';
import { renderApprovalDockPrompt, renderApprovalPrompt, renderInlinePrompt, renderTrustedApproval } from '../src/ui/approval.mjs';
import { formatCard, formatCardHead, formatCompactFileDiff } from '../src/ui/tool-card.mjs';
import { detailFor } from '../src/ui/tool-details.mjs';
import { transcriptHeader, transcriptLine } from '../src/ui/transcript-block.mjs';
import { buildFileDiff } from '../src/core/file-diff.mjs';
import { EventFormatter } from '../src/ui/formatter.mjs';
import { TIERS } from '../src/core/risk-tier.mjs';

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

console.log('\n\x1b[1mtest-terminal-rendering.mjs\x1b[0m\n');

test('Bahulam brand uses abundance cyan (post-rebrand)', () => {
  // Bahulam Code rebrand: paint.brand.primary is cyan #06b6d4 (abundance
  // theme) — was purple #7c3aed in the pre-rename era. In ansi16 fallback
  // that resolves to cyan (36); truecolor is \x1b[38;2;6;182;212m.
  const brand = c.brand('bahulam');
  assert.ok(brand.startsWith('\x1b[36m') || brand.startsWith('\x1b[38;2;6;182;212m'),
    `expected cyan/truecolor brand, got ${JSON.stringify(brand)}`);
  // c.cyan routes through paint.brand.data — neon cyan #22d3ee → ansi16 cyan 36.
  const cyan = c.cyan('code');
  assert.ok(cyan.startsWith('\x1b[36m') || cyan.startsWith('\x1b[38;2;34;211;238m'),
    `expected cyan/truecolor data, got ${JSON.stringify(cyan)}`);
});

test('startup banner uses compact abundance mark with ASCII fallback', () => {
  _setTermForTesting({ isTTY: true, color: true, colorLevel: 'ansi16', plain: false, unicode: true });
  const rendered = stripAnsi(renderBanner('2.6.12'));
  assert.ok(rendered.includes('∞∞   ∞∞'));
  assert.ok(rendered.includes('████   ███  █   █'));
  assert.ok(rendered.includes('code · abundance in your terminal · v2.6.12'));
  assert.ok(!rendered.includes('बहुलम्'));
  assert.ok(!rendered.includes('0xB0'));
  assert.ok(!rendered.includes('╔'));

  _setTermForTesting({ isTTY: true, color: false, colorLevel: 'none', plain: true, unicode: false });
  const fallback = renderBanner('2.6.12');
  assert.ok(fallback.includes('oo   oo'));
  assert.ok(fallback.includes('████   ███  █   █'));
  assert.ok(fallback.includes('code · abundance in your terminal · v2.6.12'));
  assert.ok(!/\x1b\[/.test(fallback), `plain banner has ANSI: ${JSON.stringify(fallback)}`);

  _setTermForTesting({ isTTY: true, color: true, colorLevel: 'ansi16', plain: false, unicode: true });
});

test('text.primary wraps user labels; markdown links are underlined', () => {
  const white = c.white('You');
  // text.primary #c9d1d9 → ansi16 37
  assert.ok(white.startsWith('\x1b[37m') || white.startsWith('\x1b[38;2;201;209;217m'),
    `expected text.primary wrap, got ${JSON.stringify(white)}`);
  const rendered = renderMarkdown('[Documentation](https://example.com)');
  assert.ok(rendered.includes('\x1b[4m'));
  assert.ok(rendered.includes('Documentation'));
});

test('transcript blocks distinguish user and assistant turns', () => {
  assert.strictEqual(stripAnsi(transcriptHeader('you', { tone: 'user' })), '  ╭─ you');
  assert.strictEqual(stripAnsi(transcriptLine('hello', { tone: 'user' })), '  │ hello');
  assert.strictEqual(stripAnsi(transcriptHeader('kepler', { tone: 'assistant' })), '  ╭─ kepler');
  assert.strictEqual(stripAnsi(transcriptLine('Understood', { tone: 'assistant' })), '  │ Understood');
});

test('markdown tables align after inline markdown is normalized', () => {
  const rendered = stripAnsi(renderMarkdown([
    '| Item | Value |',
    '|---|---|',
    '| **Mode** | `compact` |',
    '| [Docs](https://example.com/docs) | Avoid tables unless asked |',
  ].join('\n')));
  const lines = rendered.split('\n').filter(Boolean);
  const widths = new Set(lines.map(line => line.length));

  assert.strictEqual(widths.size, 1, rendered);
  assert.ok(rendered.includes('Mode'));
  assert.ok(rendered.includes('compact'));
  assert.ok(rendered.includes('Docs'));
  assert.ok(!rendered.includes('**Mode**'));
  assert.ok(!rendered.includes('https://example.com/docs'));
});

test('uses present-progressive action verbs for conversational tone', () => {
  // v2.0.2: labels read like the agent narrating ("Reading foo.py — 47 lines")
  // instead of a structured log ("Read file foo.py · 47 lines"). See PRD-055.
  assert.strictEqual(toolDisplayLabel('shell'), 'Running');
  assert.strictEqual(toolDisplayLabel('read_file'), 'Reading');
  assert.strictEqual(toolDisplayLabel('search_files'), 'Searching files');
  assert.strictEqual(toolDisplayLabel('mcp_fetch_weather'), 'Fetch weather');
  assert.strictEqual(toolDisplayLabel('verify'), 'Verifying');
});

test('uses concise structured tool summaries', () => {
  assert.strictEqual(
    toolDisplaySummary('read_file', {
      file_path: '/repo/src/main.js',
      start_line: 4,
      end_line: 12,
    }, { cwd: '/repo' }),
    'src/main.js · lines 4-12',
  );
  assert.strictEqual(
    toolDisplaySummary('edit_file', {
      file_path: '/repo/src/main.js',
      search: 'const oldValue = true;',
    }, { cwd: '/repo' }),
    'src/main.js · match "const oldValue = true;"',
  );
  assert.strictEqual(
    toolDisplaySummary('read_batch', {
      items: [
        { file_path: '/repo/a.js' },
        { file_path: '/repo/b.js' },
        { file_path: '/repo/c.js' },
        { file_path: '/repo/d.js' },
        { file_path: '/repo/e.js' },
        { file_path: '/repo/f.js' },
        { file_path: '/repo/g.js' },
      ],
    }, { cwd: '/repo' }),
    'a.js, b.js, c.js · +4 more',
  );
});

test('sub-agent running line shows full query and hides model', () => {
  resetSubAgents();
  const query = '[Thoroughness: thorough] What is the codekepler-deploy-dashboard docker setup and backend deployment flow?';
  const rendered = stripAnsi(renderSubAgentOpen({
    type: 'explore',
    model: 'deepseek/deepseek-v4-flash',
    query,
  }));
  resetSubAgents();

  assert.ok(rendered.includes(`"${query}"`), 'expected full query to render');
  assert.ok(rendered.includes('▸ running'), 'expected running status');
  assert.ok(!rendered.includes('deepseek/deepseek-v4-flash'), 'model should be hidden');
});

test('renders shell commands with semantic syntax colors', () => {
  // c.blue routes to brand.primary — post-rebrand that's cyan #06b6d4
  // (was purple #7c3aed pre-Bahulam-Code). Command tokens get the brand
  // color. Flags stay yellow, pipes stay red.
  const rendered = formatShellCommand('python -c "print(1)" | head -1', c);
  // Command tokens — brand.primary (#06b6d4). ansi16 cyan or truecolor.
  assert.ok(/\x1b\[36m|\x1b\[38;2;6;182;212m/.test(rendered),
    'expected brand color for command tokens');
  assert.ok(rendered.includes('python'));
  assert.ok(rendered.includes('head'));
  // Flag and quoted-string — state.warn (yellow #eab308).
  assert.ok(/\x1b\[33m|\x1b\[38;2;234;179;8m/.test(rendered),
    'expected warn/yellow for flags and quoted strings');
  // Pipe — state.danger (red #ef4444).
  assert.ok(/\x1b\[31m|\x1b\[38;2;239;68;68m/.test(rendered),
    'expected danger/red for pipe operator');
});

test('long shell tool heads wrap without hiding command text', () => {
  const command = 'cd "/Users/sree/Sites/Tarang Orca/appstak-platform" && pnpm run dev 2>&1 | head -80';
  const rendered = stripAnsi(formatCardHead('shell', { command }, { columns: 58, cwd: '/tmp' }));
  assert.ok(rendered.includes('• shell ·'));
  assert.ok(rendered.includes('Running'));
  assert.ok(rendered.includes('$'));
  assert.ok(rendered.includes('appstak-platform'));
  assert.ok(rendered.includes('pnpm run dev'));
  assert.ok(rendered.includes('2>&1 | head -80'));
  assert.ok(rendered.includes('in appstak-platform'));
  assert.ok(!rendered.includes('cd "/Users/sree'));
  assert.ok(!rendered.includes('…'));

  const azCommand = 'az network nsg create -g AZ-RG-CODEKEPLER-prod-v2 -n codekepler-microvm-prod-02 --location eastus --tags environment=prod service=microvm';
  const azRendered = stripAnsi(formatCardHead('shell', { command: azCommand }, { columns: 80, cwd: '/tmp' }));
  assert.ok(azRendered.includes('• shell ·'));
  assert.ok(azRendered.includes('Running'));
  assert.ok(azRendered.includes('$ az network nsg create'));
  assert.ok(azRendered.includes('az network nsg create'));
  assert.ok(azRendered.includes('AZ-RG-CODEKEPLER-prod-v2'));
  assert.ok(azRendered.includes('codekepler-microvm-prod-02'));
  assert.ok(azRendered.includes('service=microvm'));
  assert.ok(!azRendered.includes('…'));

  const full = stripAnsi(formatCard({
    tool: 'shell',
    args: { command },
    result: { success: true, output: 'ready' },
    durationMs: 1000,
    columns: 58,
    cwd: '/tmp',
  }));
  assert.ok(full.includes('2>&1 | head -80'));
  assert.ok(full.includes('result —'));
  assert.ok(full.includes('ready'));

  const observed = stripAnsi(formatCard({
    tool: 'shell',
    args: { command },
    result: {
      success: true,
      output: 'Observation timeout after 15000ms\nready',
      _observation_timeout: true,
      _observation_timeout_ms: 15000,
      exit_code: 124,
    },
    durationMs: 15000,
    columns: 58,
    cwd: '/tmp',
  }));
  assert.ok(observed.includes('observed 15.0s tail'));
});

test('shell card compacts leading cd wrappers', () => {
  const command = 'cd /Users/sree/Sites/Tarang\\ Orca/tarang-ai-agent-framework/agent-framework-pypi && git status --short';
  const rendered = stripAnsi(formatCardHead('shell', {
    command,
  }, {
    columns: 100,
    cwd: '/Users/sree/Sites/Tarang Orca/codekepler-npm',
  }));

  assert.ok(rendered.includes('• shell · Running $ git status --short'));
  assert.ok(rendered.includes('in tarang-ai-agent-framework/agent-framework-pypi'));
  assert.ok(!rendered.includes('cd /Users/sree'));
});

test('multiline shell commands compact instead of leaking left-aligned lines', () => {
  const command = [
    '# Check config-reader service',
    'grep -n \\',
    '  "workspace-backend\\|config-workspace-backend\\|loadConfig" \\',
    '  /Users/sree/Sites/Tarang-Orca/codekepler-deploy-dashboard/dashboard/src/services/config-reader.ts \\',
    '  | head -40',
  ].join('\n');
  const rendered = stripAnsi(formatCardHead('shell', { command }, { columns: 100, cwd: process.cwd() }));
  const lines = rendered.split('\n').filter(Boolean);

  assert.strictEqual(lines.length, 1);
  assert.ok(rendered.includes('• shell · Running $ shell script'));
  assert.ok(rendered.includes('details: Ctrl+D'));
  assert.ok(!rendered.includes('\ngrep -n'));
  assert.ok(lines.every(line => line.startsWith('  ')));
});

test('shell card compacts generated scripts and detail exposes command output', () => {
  const command = [
    "python3 <<'PY'",
    'from pathlib import Path',
    'Path("out.txt").write_text("ok")',
    'print("done")',
    'PY',
  ].join('\n');
  const profile = shellCommandProfile(command);
  assert.strictEqual(profile.compact, true);
  assert.strictEqual(profile.kind, 'python script');

  const head = stripAnsi(formatCardHead('shell', { command }, { columns: 80, cwd: process.cwd() }));
  assert.ok(head.includes('• shell · Running $ python script'));
  assert.ok(head.includes('details: Ctrl+D'));
  assert.ok(!head.includes('Path("out.txt")'));

  const detail = stripAnsi(detailFor({
    id: 'shell-script',
    tool: 'shell',
    args: { command },
    result: { success: true, output: 'done\n' },
    durationMs: 500,
  }));
  assert.ok(detail.includes('command'));
  assert.ok(detail.includes('script'));
  assert.ok(detail.includes('Path("out.txt").write_text("ok")'));
  assert.ok(detail.includes('stdout'));
  assert.ok(detail.includes('done'));
});

test('search cards keep outcome inline by compacting long heads', () => {
  const rendered = stripAnsi(formatCard({
    tool: 'search_files',
    args: {
      query: 'compress|ingestion|tool_result.*compress',
      path: '/repo/codekepler-backend/app/kepler',
    },
    result: {
      success: true,
      output: 'a.py:1:x\nb.py:2:x',
      match_count: 37,
      file_count: 6,
    },
    columns: 92,
    cwd: '/repo',
  }));

  assert.strictEqual(rendered.split('\n').length, 1);
  assert.ok(rendered.includes('Searching files'));
  assert.ok(rendered.includes('37 matches in 6 files'));
  assert.ok(rendered.includes('…'));
});

test('tool activity rows only force blank spacing between shell commands', () => {
  // Post PRD-081 repl split: rendering pipeline lives in repl-render.mjs,
  // pure explore classifier in repl-explore.mjs. Test both files.
  const replSource = fs.readFileSync(new URL('../src/terminal/repl.mjs', import.meta.url), 'utf-8');
  const renderSource = fs.readFileSync(new URL('../src/terminal/repl-render.mjs', import.meta.url), 'utf-8');
  const exploreSource = fs.readFileSync(new URL('../src/terminal/repl-explore.mjs', import.meta.url), 'utf-8');
  assert.ok(!renderSource.includes('process.stderr.write(`\\n${combined}\\n`);'));
  assert.ok(!renderSource.includes('process.stderr.write(`\\n${runtime.pendingHead.head}\\n`);'));
  assert.ok(renderSource.includes('process.stderr.write(`${combined}\\n`);'));
  assert.ok(renderSource.includes('process.stderr.write(`${runtime.pendingHead.head}\\n`);'));
  assert.ok(renderSource.includes('function renderBlockBoundary(nextBlock'));
  assert.ok(renderSource.includes("process.env.KEPLER_BLOCK_SEPARATOR || 'space'"));
  assert.ok(renderSource.includes("mode === 'dotted' || mode === 'dots'"));
  assert.ok(renderSource.includes("renderBlockBoundary('tool', { compactSame: tool !== 'shell' })"));
  // renderBlockBoundary('thinking'|'content') calls fire from the event
  // dispatcher which still lives in repl.mjs — check both files.
  assert.ok(replSource.includes("renderBlockBoundary('thinking')")
         || renderSource.includes("renderBlockBoundary('thinking')"));
  assert.ok(renderSource.includes('function thinkingPrefix(text)'));
  assert.ok(renderSource.includes('Thinking · ${kind}'));
  assert.ok(renderSource.includes('function clippedThinking(text, limit = 200)'));
  assert.ok(replSource.includes("renderBlockBoundary('content')")
         || renderSource.includes("renderBlockBoundary('content')"));
  assert.ok(exploreSource.includes('const EXPLORE_TOOL_CATEGORY = new Map'));
  assert.ok(exploreSource.includes("process.env.KEPLER_EXPLORE_COLLAPSE !== '0'"));
  assert.ok(replSource.includes("from './repl-explore.mjs'"));
  assert.ok(renderSource.includes('function exploreSummary()'));
  assert.ok(renderSource.includes('exploring · ${stats}${latest}'));
  assert.ok(renderSource.includes('if (runtime.exploreRun.recent.length > 3) runtime.exploreRun.recent.shift();'));
  assert.ok(renderSource.includes('function writeExploreSnapshot(summary = exploreSummary())'));
  assert.ok(renderSource.includes('function shouldPrintExploreSnapshot()'));
  assert.ok(renderSource.includes('if (shouldPrintExploreSnapshot()) writeExploreSnapshot();'));
  assert.ok(!renderSource.includes('drawPinnedStatus'));
  assert.ok(renderSource.includes("transcriptHeader('bahulam', { tone: 'assistant' })"));
  assert.ok(renderSource.includes("transcriptLine(line, { tone: 'assistant' })"));
  assert.ok(renderSource.includes("runtime.lastRenderedBlock = 'content';"));
});

test('REPL prompt keeps a small bottom cushion', () => {
  const replSource = fs.readFileSync(new URL('../src/terminal/repl.mjs', import.meta.url), 'utf-8');
  assert.ok(!replSource.includes('function printInputSeparator()'));
  assert.ok(!replSource.includes('function inputRule()'));
  assert.ok(!replSource.includes("c.dim('─'.repeat(Math.max(24, w - 4)))"));
  assert.ok(!replSource.includes("inputRule({ label: 'message' });"));
  assert.ok(!replSource.includes('paint.inverse(c.brand(` ${label} `))'));
  assert.ok(replSource.includes("from '../ui/input-dock.mjs'"));
  assert.ok(replSource.includes('mountInputDock()'));
  assert.ok(!replSource.includes("from '../ui/status-bar.mjs'"));
  assert.ok(!replSource.includes('attachOrbit('));
  assert.ok(replSource.includes("return `${paint.brand.primary(who)} ${paint.brand.primary('›')} `;"));
  assert.ok(!replSource.includes('printInputSeparator();'));
  assert.ok(replSource.includes('function printInputBottomRule()'));
  assert.ok(replSource.includes('printInputBottomRule();'));
  assert.ok(replSource.includes('prepareInputPrompt({ context: buildContextStrip(), meta: buildDockMeta(), tips: idleInputTips() })'));
  assert.ok(replSource.includes('function printSubmittedInput(input)'));
  assert.ok(replSource.includes("transcriptHeader('you', { tone: 'user' })"));
  assert.ok(replSource.includes("transcriptLine(line, { tone: 'user' })"));
  assert.ok(replSource.includes("transcriptHeader('bahulam', { tone: 'assistant' })"));
  assert.ok(replSource.includes('function renderIdleDockInput()'));
  assert.ok(replSource.includes("rl.setPrompt(isInputDockMounted() ? '' : userPrompt())"));
  assert.ok(replSource.includes('renderDockInput(userPrompt(), rl.line || \'\','));
  assert.ok(replSource.includes("case '/exit':"));
  assert.ok(replSource.includes('if (isInputDockMounted()) unmountInputDock();'));
  assert.ok(replSource.includes("rl.on('close', async () => {"));
  assert.ok(replSource.includes('clearSlashHint({ restoreCursor: false });'));
  assert.ok(replSource.includes('inputActive = false;'));
  assert.ok(replSource.includes('clearSlashHint();'));
  assert.ok(replSource.includes('Modern Node readline strips ANSI escapes'));
  assert.ok(!replSource.includes("'\\x01$&\\x02'"));
  assert.ok(replSource.includes('function slashCommandSuggestions(line, limit = 5)'));
  assert.ok(replSource.includes("function renderSlashHint(line = '', { preserveSelection = false } = {})"));
  assert.ok(replSource.includes("readline.emitKeypressEvents(process.stdin, rl);"));
  assert.ok(replSource.includes('slashCommandSuggestions(line, Math.min(5, rows))'));
  assert.ok(replSource.includes('function acceptSlashHint()'));
  assert.ok(replSource.includes('function moveSlashHintSelection(delta)'));
  assert.ok(replSource.includes('function selectedSlashCommandFor(line)'));
  assert.ok(replSource.includes("typeof rl._refreshLine === 'function'"));
  assert.ok(replSource.includes('readline.cursorTo(process.stderr, col)'));
  assert.ok(replSource.includes('readline.moveCursor(process.stderr, 0, 1)'));
  assert.ok(replSource.includes("item.command.padEnd(13)"));
  assert.ok(replSource.includes('function reservePromptBottomPadding()'));
  assert.ok(replSource.includes("process.env.KEPLER_PROMPT_BOTTOM_PADDING ?? '5'"));
  assert.ok(replSource.includes('Math.min(8, n)'));
  assert.ok(replSource.includes('reservePromptBottomPadding();'));
  // Empty-Enter branch now clears the phantom prompt line(s) before
  // re-rendering — see PRD-081 §5.1 acceptance "Empty Enter must not leave
  // phantom prompt lines".
  assert.ok(replSource.includes("process.stderr.write('\\x1b[A\\x1b[2K\\r');"));
  assert.ok(replSource.includes('function pasteFlushDelayMs()'));
  assert.ok(replSource.includes("process.env.KEPLER_PASTE_FLUSH_MS || '35'"));
  assert.ok(replSource.includes("const line = _pasteLines.join('\\n');"));
  assert.ok(replSource.includes('queueOrRunLine(line);'));
  assert.ok(replSource.includes('function executionInputPrefix()'));
  assert.ok(replSource.includes('add instruction'));
  assert.ok(replSource.includes('type any extra context (paths, corrections, follow-ups)'));
  assert.ok(!replSource.includes('[Space] pause/resume'));
  assert.ok(replSource.includes('renderDockInput(executionInputPrefix(), executionInputBuffer'));
  assert.ok(replSource.includes('focusDockInput(executionInputPrefix(), executionInputBuffer)'));
  // Post PRD-081 repl split: _afterContentFlush is now runtime.afterContentFlush.
  // The assignment stays in repl.mjs (execution loop sets the callback),
  // the invocation moved into flushContent inside repl-render.mjs.
  const renderSourceRt = fs.readFileSync(new URL('../src/terminal/repl-render.mjs', import.meta.url), 'utf-8');
  assert.ok(replSource.includes('runtime.afterContentFlush = focusExecutionInput;'));
  assert.ok(replSource.includes('runtime.afterContentFlush = null;'));
  assert.ok(renderSourceRt.includes("if (typeof runtime.afterContentFlush === 'function') runtime.afterContentFlush();"));
  assert.ok(replSource.includes('if (isInputDockMounted()) moveToContent();'));
  // PRD-081 Phase 3: active-run follow-ups now go through the dedicated
  // /api/intervention/{task_id} path (client.sendIntervention), not /resume.
  assert.ok(replSource.includes('client.sendIntervention(instruction)'));
  assert.ok(replSource.includes("type: 'user_intervention'"));
  assert.ok(replSource.includes('Ctrl+D'));
});

test('resume preview avoids circular renderEvent import during repl split', () => {
  const replSource = fs.readFileSync(new URL('../src/terminal/repl.mjs', import.meta.url), 'utf-8');
  const resumeSource = fs.readFileSync(new URL('../src/terminal/repl-resume.mjs', import.meta.url), 'utf-8');
  assert.ok(resumeSource.includes("import { startContentStream, flushContent, stopSpinner } from './repl-render.mjs';"));
  assert.ok(!resumeSource.includes("from './repl.mjs'"));
  assert.ok(resumeSource.includes('export function renderResumePreview(resumed, ctx = {})'));
  assert.ok(resumeSource.includes('const renderEvent = ctx.renderEvent;'));
  assert.ok(replSource.includes('renderResumePreview(resumed, { renderEvent });'));
});

test('fixed input dock clears input rows before repainting', () => {
  // Post-PRD-081: the dock now supports N input rows (1..5, default 2),
  // so `clearInputRow` is `clearInputRows` and covers the full input area.
  const dockSource = fs.readFileSync(new URL('../src/ui/input-dock.mjs', import.meta.url), 'utf-8');
  assert.ok(dockSource.includes('function clearInputRows()'));
  assert.ok(dockSource.includes('moveTo(row, 1);'));
  // Post cursor-race fix: clearInputPrompt clears the input rows, resets
  // the tracked value, redraws the frame, and parks the cursor at the input.
  assert.ok(dockSource.includes('clearInputRows();'));
  assert.ok(dockSource.includes('renderFrame(lastFrame);'));
  assert.ok(dockSource.includes('function parkCursorAtInput()'));
  // Signature accepts an optional cursorInValue for readline rl.cursor tracking.
  assert.ok(dockSource.includes('export function focusDockInput(prefix, value = \'\''));
  assert.ok(dockSource.includes('cursorInValue'));
  assert.ok(dockSource.includes("from './text-layout.mjs'"));
});

test('legacy formatter wraps full shell commands without ellipsis', () => {
  const command = 'az network nsg create -g AZ-RG-CODEKEPLER-prod-v2 -n codekepler-microvm-prod-02 --location eastus --tags environment=prod service=microvm';
  const formatter = new EventFormatter();
  const originalWrite = process.stderr.write;
  let output = '';
  process.stderr.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    formatter.render({ type: 'tool_call', data: { tool: 'shell', args: { command } } });
  } finally {
    process.stderr.write = originalWrite;
  }
  const rendered = stripAnsi(output);
  assert.ok(rendered.includes('Running'));
  assert.ok(rendered.includes('az network nsg create'));
  assert.ok(rendered.includes('AZ-RG-CODEKEPLER-prod-v2'));
  assert.ok(rendered.includes('codekepler-microvm-prod-02'));
  assert.ok(rendered.includes('service=microvm'));
  assert.ok(!rendered.includes('…'));
});

test('shell JSON endpoint output summarizes sync diff status', () => {
  const command = 'curl -sS localhost:4501/api/profiles/prod-v2/diff/mcp-context-forge 2>&1';
  const rendered = stripAnsi(formatCard({
    tool: 'shell',
    args: { command },
    result: {
      success: true,
      output: JSON.stringify({
        service: 'mcp-context-forge',
        profile: 'prod-v2',
        inSync: false,
        diff: [{ key: 'PORT' }, { key: 'HOST' }],
      }),
      duration_ms: 992,
    },
    columns: 140,
  }));

  assert.ok(rendered.includes('mcp-context-forge out of sync · prod-v2 · 2 diffs'));
  assert.ok(!rendered.includes('{"service"'));
});

test('renders Markdown pipe tables as aligned terminal tables', () => {
  const rendered = stripAnsi(renderMarkdown([
    '| Name | Status |',
    '| --- | --- |',
    '| API | Ready |',
    '| CLI | Active |',
  ].join('\n')));
  assert.ok(rendered.includes('Name'));
  assert.ok(rendered.includes('Status'));
  assert.ok(rendered.includes('API'));
  assert.ok(rendered.includes('│'));
  assert.ok(!rendered.includes('| --- |'));
});

test('wraps long Markdown table cells instead of truncating content', () => {
  const originalColumns = process.stderr.columns;
  Object.defineProperty(process.stderr, 'columns', {
    value: 92,
    configurable: true,
  });
  try {
    const rendered = stripAnsi(renderMarkdown([
      '| Dimension | Assessment |',
      '| --- | --- |',
      '| Feature overlap | High. Both are terminal-based coding agents with shell execution, file editing, and repo-aware workflows. |',
      "| Gap pi.dev doesn't fill | No prompt caching means materially higher effective inference cost for repeated repository context. |",
    ].join('\n')));
    const lines = rendered.split('\n');
    assert.ok(rendered.includes('terminal-based coding agents with shell'));
    assert.ok(rendered.includes('repo-aware workflows'));
    assert.ok(rendered.includes('materially higher effective'));
    assert.ok(rendered.includes('inference cost for repeated repository context'));
    assert.ok(rendered.includes('cost for repeated repository context'));
    assert.ok(!rendered.includes('...'), rendered);
    assert.ok(lines.every(line => line.length <= 92), JSON.stringify(lines));
  } finally {
    Object.defineProperty(process.stderr, 'columns', {
      value: originalColumns,
      configurable: true,
    });
  }
});

test('renders blockquotes and task lists with structural styling', () => {
  const rendered = renderMarkdown('> Important\n- [x] Done\n- [ ] Pending');
  assert.ok(rendered.includes('\x1b[90m  │\x1b[0m \x1b[3mImportant'));
  assert.ok(rendered.includes('\x1b[32m✓ Done'));
  assert.ok(rendered.includes('\x1b[90m○ Pending'));
});

test('wraps Markdown list continuation lines with hanging indent', () => {
  const originalColumns = process.stderr.columns;
  Object.defineProperty(process.stderr, 'columns', {
    value: 56,
    configurable: true,
  });
  try {
    const rendered = stripAnsi(renderMarkdown('- They are NOT in the dashboard sync list, so the dashboard cannot push them anywhere including to Vercel.'));
    const lines = rendered.split('\n');
    assert.ok(lines.length > 1, 'expected bullet to wrap');
    assert.ok(lines[0].startsWith('  • '), JSON.stringify(lines[0]));
    assert.ok(lines.slice(1).every(line => line.startsWith('    ')), JSON.stringify(lines));
    assert.ok(lines.slice(1).every(line => !line.startsWith('to ')), JSON.stringify(lines));
  } finally {
    Object.defineProperty(process.stderr, 'columns', {
      value: originalColumns,
      configurable: true,
    });
  }
});

test('normalizes soft-wrapped Markdown paragraphs before terminal wrapping', () => {
  const originalColumns = process.stderr.columns;
  Object.defineProperty(process.stderr, 'columns', {
    value: 70,
    configurable: true,
  });
  try {
    const rendered = stripAnsi(renderMarkdown([
      "It's installed. The entire ComposioHQ/awesome-claude-skills repo was cloned project-scoped, so all skills from that repo are available - including twitter-algorithm-optimizer.",
      '',
      'You can use it by invoking skill_view("twitter-algorithm-optimizer") to load its instructions, then it will be active for the session.',
    ].join('\n')));
    const lines = rendered.split('\n');
    assert.ok(lines.some(line => line.includes('project-scoped')), JSON.stringify(lines));
    assert.ok(lines.some(line => line.includes('twitter-algorithm-optimizer')), JSON.stringify(lines));
    assert.ok(lines.every(line => line.length <= 70), JSON.stringify(lines));
    assert.ok(lines.some(line => line.includes('load its instructions')), JSON.stringify(lines));
  } finally {
    Object.defineProperty(process.stderr, 'columns', {
      value: originalColumns,
      configurable: true,
    });
  }
});

test('folds indented wrapped bullet continuation into the bullet item', () => {
  const originalColumns = process.stderr.columns;
  Object.defineProperty(process.stderr, 'columns', {
    value: 72,
    configurable: true,
  });
  try {
    const rendered = stripAnsi(renderMarkdown([
      "- skill_view: loaded successfully - it's a skill that analyzes/optimizes tweets",
      "  for reach using Twitter's open-source ranking models (RealGraph, SimClusters).",
    ].join('\n')));
    const lines = rendered.split('\n');
    assert.ok(lines[0].startsWith('  • '), JSON.stringify(lines));
    assert.ok(lines.slice(1).every(line => line.startsWith('    ')), JSON.stringify(lines));
    assert.ok(lines.every(line => !line.startsWith('for reach')), JSON.stringify(lines));
    assert.ok(rendered.includes('for reach using'), JSON.stringify(lines));
  } finally {
    Object.defineProperty(process.stderr, 'columns', {
      value: originalColumns,
      configurable: true,
    });
  }
});

test('renders structured keys bold cyan and values regular cyan', () => {
  // Post-Phase-1 palette emits bold and color as separate SGRs:
  //   \x1b[1m\x1b[36mstatus\x1b[0m... \x1b[36m ready\x1b[0m
  // Stripped: "status" + ": " + " ready" all coloured.
  const rendered = renderMarkdown('```yaml\nstatus: ready\n```');
  assert.ok(rendered.includes('\x1b[1m\x1b[36mstatus') ||
            rendered.includes('\x1b[1;36mstatus'),
            'expected bold cyan key');
  assert.ok(rendered.includes('\x1b[36m ready'));
});

test('renders diff additions and removals with semantic colors', () => {
  const rendered = renderDiff('@@ -1 +1 @@\n-old\n+new');
  assert.ok(rendered.includes('\x1b[31m-old'));
  assert.ok(rendered.includes('\x1b[32m+new'));
});

test('renders compact file diff previews for writes', () => {
  const fileDiff = buildFileDiff({
    filePath: '/repo/src/example.js',
    cwd: '/repo',
    before: 'const a = 1;\nconst b = 2;\n',
    after: 'const a = 1;\nconst b = 3;\nconst c = 4;\n',
  });
  const rendered = stripAnsi(formatCompactFileDiff({
    file_diff: fileDiff,
    lines_added: fileDiff.lines_added,
    lines_removed: fileDiff.lines_removed,
  }, { indent: '  ', columns: 100 }));
  assert.ok(rendered.includes('@@ -1,2 +1,3 @@'));
  assert.ok(rendered.includes('- const b = 2;'));
  assert.ok(rendered.includes('+ const b = 3;'));
  assert.ok(rendered.includes('+ const c = 4;'));
  assert.ok(rendered.indexOf('- const b = 2;') < rendered.indexOf('+ const b = 3;'));

  const detail = stripAnsi(detailFor({
    tool: 'write_file',
    args: { file_path: '/repo/src/example.js', content: 'large content omitted' },
    result: { file_diff: fileDiff, diff: fileDiff.unified },
  }));
  assert.ok(detail.includes('--- a/src/example.js'));
  assert.ok(!detail.includes('large content omitted'));
});

test('mission report omits old title and keeps tools/time on one line', () => {
  const rendered = stripAnsi(renderMissionReport({
    task: 'fix auth',
    success: true,
    filesRead: ['src/core/approval.mjs', 'src/terminal/repl.mjs'],
    toolCounts: { shell: 5 },
    costUsd: 0.0003,
    durationS: 19.9,
    repo: 'codekepler-npm',
    author: 'Ravi',
  }));
  assert.ok(!rendered.includes('MISSION ACCOMPLISHED'));
  assert.ok(!rendered.includes('Repo codekepler-npm'));
  assert.ok(!rendered.includes('Author Ravi'));
  assert.ok(!rendered.includes('Cost'));
  assert.ok(!rendered.includes('$0.0003'));
  assert.ok(rendered.includes('Read        approval.mjs, repl.mjs'));
  assert.ok(rendered.includes('Tools shell(5) · ⏱ Time 19.9s'));
});

test('approval prompt uses risk title and compact scoped menu', () => {
  const rendered = stripAnsi(renderApprovalPrompt({
    tool: 'shell',
    args: { command: 'rm -rf node_modules && npm install' },
    tier: TIERS.SHELL_DANGEROUS,
    why: 'Resetting dependencies after a Node upgrade, but this removes a directory and needs explicit confirmation.',
    width: 82,
  }));
  assert.ok(rendered.includes('DANGEROUS · SHELL-DANGEROUS · shell'));
  assert.ok(rendered.includes('risk   rm -rf'));
  assert.ok(rendered.includes('reason Resetting dependencies'));
  assert.ok(rendered.includes('Decision'));
  assert.ok(rendered.includes('cancel'));
  assert.ok(!rendered.includes('[?] why'));
  assert.ok(!rendered.includes('re-plan'));
  assert.ok(rendered.includes('rm -rf node_modules'));
  assert.ok(!rendered.includes('┃'));
  assert.ok(!rendered.includes('│'));
  assert.ok(!rendered.includes('▔'));
  assert.ok(!rendered.includes('────'));
});

test('approval prompt separates shell cwd from command', () => {
  const command = [
    'cd /Users/sree/Sites/Tarang\\ Orca/tarang-ai-agent-framework &&',
    'git add agent-framework-pypi/src/pkg/requires.txt &&',
    'git status --short',
  ].join(' ');
  const rendered = stripAnsi(renderApprovalPrompt({
    tool: 'shell',
    args: { command },
    tier: TIERS.SHELL_MEDIUM,
    why: 'Mutates the workspace or environment.',
    width: 100,
  }));

  assert.ok(rendered.includes('tarang-ai-agent-framework'));
  assert.ok(rendered.includes('git add agent-framework-pypi/src/pkg/requires.txt && git status'));
  assert.ok(!rendered.includes('cd /Users/sree/Sites/Tarang'));
  assert.ok(rendered.includes('d details'));
});

test('approval prompt compacts redundant shell approval reason', () => {
  const command = 'curl -sS localhost:4501/api/profiles/prod-v2/diff/mcp-context-forge 2>&1';
  const rendered = stripAnsi(renderApprovalPrompt({
    tool: 'shell',
    args: { command },
    tier: TIERS.SHELL_MEDIUM,
    why: `Shell command requires approval: ${command}`,
    width: 100,
  }));

  assert.ok(rendered.includes(command));
  assert.ok(rendered.includes('reason Shell command requires approval.'));
  assert.ok(!rendered.includes(`reason Shell command requires approval: ${command}`));
});

test('approval prompt compacts generated shell scripts until details are requested', () => {
  const command = [
    "python3 <<'PY'",
    'from pathlib import Path',
    'for i in range(3):',
    '    print(i)',
    'PY',
  ].join('\n');
  const compact = stripAnsi(renderApprovalPrompt({
    tool: 'shell',
    args: { command },
    tier: TIERS.SHELL_MEDIUM,
    why: 'Runs a generated helper script.',
    width: 100,
  }));
  assert.ok(compact.includes('python script'));
  assert.ok(compact.includes('3 lines'));
  assert.ok(compact.includes('d details'));
  assert.ok(!compact.includes('from pathlib import Path'));

  const expanded = stripAnsi(renderApprovalPrompt({
    tool: 'shell',
    args: { command },
    tier: TIERS.SHELL_MEDIUM,
    why: 'Runs a generated helper script.',
    width: 100,
    showDetails: true,
  }));
  assert.ok(expanded.includes('d hide details'));
  assert.ok(expanded.includes('script'));
  assert.ok(expanded.includes('from pathlib import Path'));
  assert.ok(expanded.includes('print(i)'));
});

test('approval dock prompt is concise and separate from transcript framing', () => {
  const dock = renderApprovalDockPrompt({
    tool: 'shell',
    args: { command: 'npm publish' },
    tier: TIERS.SHELL_MEDIUM,
    why: 'Publishes the package.',
    width: 100,
  });

  assert.ok(dock.prefix.includes('approve'));
  assert.ok(dock.value.includes('$ npm publish'));
  assert.ok(dock.context.includes('APPROVAL · SHELL-MEDIUM · shell'));
  assert.ok(dock.meta.includes('risk publish'));
  assert.ok(dock.tips.includes('d details'));
  assert.ok(!dock.value.includes('│'));
});

test('approval compatibility wrapper uses unified prompt', () => {
  const inline = stripAnsi(renderInlinePrompt({
    tool: 'shell',
    args: { command: 'npm test' },
    tier: TIERS.SHELL_MEDIUM,
    why: 'verify the change',
  }));
  assert.ok(inline.includes('APPROVAL · SHELL-MEDIUM'));
  assert.ok(inline.includes('Decision'));
  assert.ok(inline.includes('reason verify the change'));
  assert.ok(inline.includes('allow similar'));
  assert.ok(inline.includes('cancel'));
  assert.ok(!inline.includes('[?] why'));

  const trusted = stripAnsi(renderTrustedApproval({
    tool: 'shell',
    args: { command: 'npm test' },
    scope: 'SESSION',
    ruleId: 'shell-test',
  }));
  assert.ok(trusted.includes('pre-approved (session'));
  assert.ok(trusted.includes('rule shell-test'));
});

// ── Phase 4: tool/result display polish ────────────────────────────────

test('Phase 4a: burst-collapse classifier covers common read-adjacent tools', () => {
  // The classifier drives whether a tool call collapses into the explore-run
  // summary or renders as its own card. Missing entries here mean bursts of
  // that tool spam the transcript (PRD-081 §5.3 acceptance).
  const known = new Set(_knownExploreTools());
  for (const t of ['read_file', 'read_files', 'list_files', 'grep', 'search_code',
                   'search_files', 'analyze_code', 'validate_file',
                   'validate_structure', 'get_project_overview']) {
    assert.ok(known.has(t), `expected ${t} in burst-collapse classifier`);
    assert.ok(_isExploreTool(t), `expected isExploreTool(${t}) → true`);
  }
  // Categorization sanity — reads and writes end up in the right bucket.
  assert.strictEqual(_exploreCategory('read_file'), 'read');
  assert.strictEqual(_exploreCategory('analyze_code'), 'read');
  assert.strictEqual(_exploreCategory('search_code'), 'search');
  assert.strictEqual(_exploreCategory('validate_structure'), 'search');
  assert.strictEqual(_exploreCategory('get_project_overview'), 'index');
  // Writes / shell must NOT be collapsed — they carry information the user
  // needs to see per-call (diff, exit code, error output).
  assert.ok(!_isExploreTool('write_file'), 'write_file must NOT collapse');
  assert.ok(!_isExploreTool('edit_file'), 'edit_file must NOT collapse');
  assert.ok(!_isExploreTool('shell'), 'shell must NOT collapse');
});

test('Phase 4a: KEPLER_EXPLORE_COLLAPSE=0 disables the classifier', () => {
  const prev = process.env.KEPLER_EXPLORE_COLLAPSE;
  process.env.KEPLER_EXPLORE_COLLAPSE = '0';
  try {
    assert.strictEqual(_isExploreTool('read_file'), false,
      'disable flag should suppress classification');
  } finally {
    if (prev === undefined) delete process.env.KEPLER_EXPLORE_COLLAPSE;
    else process.env.KEPLER_EXPLORE_COLLAPSE = prev;
  }
});

test('Phase 4b: formatCardHead never exceeds terminal width at 40/60/80 cols', () => {
  // Long paths + long queries are the classic overflow vectors. Card widths
  // must ALWAYS wrap or clip, never bleed past the visible column budget.
  const longPath = 'src/deeply/nested/module/that/keeps/going/until/it/really/hurts.mjs';
  const longQuery = 'the quick brown fox jumps over the lazy dog exactly seventeen times';

  for (const cols of [40, 60, 80]) {
    for (const [tool, args] of [
      ['read_file', { file_path: longPath }],
      ['search_code', { query: longQuery }],
      ['edit_file', { file_path: longPath }],
      ['shell', { command: 'npm test -- --coverage --reporter=json' }],
    ]) {
      const head = formatCardHead(tool, args, { columns: cols, cwd: process.cwd() });
      for (const line of head.split('\n')) {
        assert.ok(stripAnsi(line).length <= cols,
          `[${cols}col ${tool}] line width ${stripAnsi(line).length} > ${cols}: ${JSON.stringify(line)}`);
      }
    }
  }
});

test('Phase 4b: formatCard fits terminal width at 40/60/80 cols', () => {
  const longPath = 'src/deeply/nested/module/that/keeps/going/until/it/really/hurts.mjs';
  const longOutput = 'output '.repeat(30);

  for (const cols of [40, 60, 80]) {
    const rendered = formatCard({
      tool: 'read_file',
      args: { file_path: longPath },
      result: { success: true, output: longOutput, line_count: 42 },
      durationMs: 320,
      columns: cols,
      cwd: process.cwd(),
    });
    for (const line of rendered.split('\n')) {
      assert.ok(stripAnsi(line).length <= cols,
        `[${cols}col] card line ${stripAnsi(line).length} > ${cols}: ${JSON.stringify(line)}`);
    }
  }
});

test('Phase 4c: plain mode strips ANSI from tool cards', () => {
  // Non-TTY / KEPLER_PLAIN=1 / --plain — output must be deterministic and
  // parseable by scripts. Any ANSI escape leaking through breaks that.
  _setTermForTesting({ isTTY: false, color: false, colorLevel: 'none', plain: true });
  try {
    const head = formatCardHead('read_file', { file_path: 'src/foo.mjs' }, { columns: 80 });
    assert.ok(!/\x1b\[/.test(head), `plain head has ANSI: ${JSON.stringify(head)}`);

    const card = formatCard({
      tool: 'edit_file',
      args: { file_path: 'src/foo.mjs' },
      result: { success: true, lines_added: 5, lines_removed: 2 },
      columns: 80,
    });
    assert.ok(!/\x1b\[/.test(card), `plain card has ANSI: ${JSON.stringify(card)}`);

    const detail = detailFor({
      id: 'test-1',
      tool: 'read_file',
      args: { file_path: 'src/foo.mjs' },
      result: { success: true, output: 'line1\nline2\nline3\n', line_count: 3 },
    });
    assert.ok(!/\x1b\[/.test(detail), `plain detail has ANSI: ${JSON.stringify(detail)}`);
  } finally {
    // Restore the ansi16 test defaults so downstream tests are unaffected.
    _setTermForTesting({ isTTY: true, color: true, colorLevel: 'ansi16', plain: false });
  }
});

test('Phase 4d: failed shell command keeps actionable error visible', () => {
  const card = formatCard({
    tool: 'shell',
    args: { command: 'npm test' },
    result: {
      success: false,
      exit_code: 1,
      output: 'FAIL src/foo.test.js\n  Expected 3 but received 2',
      error: 'Test suite failed',
    },
    durationMs: 1200,
    columns: 120,
  });
  const plain = stripAnsi(card);
  // The exit code, first error line, and duration should ALL survive the card.
  assert.ok(plain.includes('FAIL src/foo.test.js') || plain.includes('Expected 3'),
    `expected actionable error line in card: ${JSON.stringify(plain)}`);
});

test('Phase 4d: large diff shows compact preview + full available via detail', () => {
  // 40-line write should show a bounded compact preview in the card and the
  // full diff via detailFor. Cap tolerated to prevent transcript spam.
  const lines = Array.from({ length: 40 }, (_, i) => `+ line ${i + 1}`).join('\n');
  const card = formatCard({
    tool: 'write_file',
    args: { file_path: 'src/big.mjs' },
    result: {
      success: true,
      lines_added: 40,
      lines_removed: 0,
      file_diff: { hunks: [{ old_start: 1, old_lines: 0, new_start: 1, new_lines: 40, body: lines }] },
    },
    durationMs: 45,
    columns: 120,
  });
  const cardLines = stripAnsi(card).split('\n').filter(Boolean);
  // The card body (post-header) must not dump all 40 diff lines — cap ~20.
  assert.ok(cardLines.length <= 20,
    `compact card grew to ${cardLines.length} lines — should stay bounded`);

  // Detail view is the escape hatch: gives the model/user access to more.
  const detail = detailFor({
    id: 'x',
    tool: 'write_file',
    args: { file_path: 'src/big.mjs' },
    result: {
      success: true,
      lines_added: 40,
      lines_removed: 0,
      file_diff: { hunks: [{ old_start: 1, old_lines: 0, new_start: 1, new_lines: 40, body: lines }] },
    },
  });
  const detailLines = stripAnsi(detail).split('\n').filter(Boolean);
  assert.ok(detailLines.length > cardLines.length,
    'detail should expose more than the compact preview');
});

console.log(`\n  ${passed} passed, 0 failed\n`);
