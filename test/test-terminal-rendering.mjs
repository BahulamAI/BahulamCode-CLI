import assert from 'node:assert';
import * as fs from 'node:fs';
// Force ansi16 capability before importing palette-aware modules so the
// test runs the same way under `npm test` (no TTY) as on a terminal.
import { _setForTesting as _setTermForTesting } from '../src/ui/term.mjs';
_setTermForTesting({ isTTY: true, color: true, colorLevel: 'ansi16', plain: false });

import { c, renderMarkdown, renderDiff, stripAnsi } from '../src/terminal/ansi.mjs';
import { formatShellCommand, toolDisplayLabel, toolDisplaySummary } from '../src/terminal/tool-display.mjs';
import { renderMissionReport } from '../src/ui/mission-report.mjs';
import { renderApprovalPrompt, renderInlinePrompt, renderTrustedApproval } from '../src/ui/approval.mjs';
import { formatCard, formatCardHead, formatCompactFileDiff } from '../src/ui/tool-card.mjs';
import { detailFor } from '../src/ui/tool-details.mjs';
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

test('Kepler brand uses Deep Space Purple (PRD-055 §4.1)', () => {
  // Post-Phase-1: c.brand routes through paint.brand.primary (#7c3aed).
  // In ansi16 fallback that resolves to magenta (35); in truecolor it is
  // \x1b[38;2;124;58;237m. Accept either so the test runs in any terminal.
  const brand = c.brand('kepler');
  assert.ok(brand.startsWith('\x1b[35m') || brand.startsWith('\x1b[38;2;124;58;237m'),
    `expected magenta/truecolor brand, got ${JSON.stringify(brand)}`);
  // c.cyan now routes through paint.brand.data — neon cyan #22d3ee → ansi16 cyan 36.
  const cyan = c.cyan('code');
  assert.ok(cyan.startsWith('\x1b[36m') || cyan.startsWith('\x1b[38;2;34;211;238m'),
    `expected cyan/truecolor data, got ${JSON.stringify(cyan)}`);
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
});

test('renders shell commands with semantic syntax colors', () => {
  // Post-Phase-1: c.blue routes to brand.primary, so command tokens get the
  // brand color instead of basic blue. Flags stay yellow, pipes stay red.
  const rendered = formatShellCommand('python -c "print(1)" | head -1', c);
  // Command tokens — brand.primary (#7c3aed). ansi16 magenta or truecolor.
  assert.ok(/\x1b\[35m|\x1b\[38;2;124;58;237m/.test(rendered),
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
  assert.ok(rendered.includes('Running'));
  assert.ok(rendered.includes('appstak-platform'));
  assert.ok(rendered.includes('pnpm run dev'));
  assert.ok(rendered.includes('2>&1 | head -80'));
  assert.ok(!rendered.includes('…'));

  const azCommand = 'az network nsg create -g AZ-RG-CODEKEPLER-prod-v2 -n codekepler-microvm-prod-02 --location eastus --tags environment=prod service=microvm';
  const azRendered = stripAnsi(formatCardHead('shell', { command: azCommand }, { columns: 80, cwd: '/tmp' }));
  assert.ok(azRendered.includes('Running'));
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

test('tool activity rows do not insert blank lines between consecutive tools', () => {
  const replSource = fs.readFileSync(new URL('../src/terminal/repl.mjs', import.meta.url), 'utf-8');
  assert.ok(!replSource.includes('process.stderr.write(`\\n${combined}\\n`);'));
  assert.ok(!replSource.includes('process.stderr.write(`\\n${_pendingHead.head}\\n`);'));
  assert.ok(replSource.includes('process.stderr.write(`${combined}\\n`);'));
  assert.ok(replSource.includes('process.stderr.write(`${_pendingHead.head}\\n`);'));
  assert.ok(replSource.includes("if (_lastRenderedBlock === 'tool') process.stderr.write('\\n');"));
  assert.ok(replSource.includes("_lastRenderedBlock = 'content';"));
});

test('REPL prompt keeps a small bottom cushion', () => {
  const replSource = fs.readFileSync(new URL('../src/terminal/repl.mjs', import.meta.url), 'utf-8');
  assert.ok(replSource.includes('function printInputSeparator()'));
  assert.ok(replSource.includes("c.brand('input')"));
  assert.ok(replSource.includes('printInputSeparator();'));
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
  assert.ok(replSource.includes('if (!input) { promptInputLine(); return; }'));
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

test('renders blockquotes and task lists with structural styling', () => {
  const rendered = renderMarkdown('> Important\n- [x] Done\n- [ ] Pending');
  assert.ok(rendered.includes('\x1b[90m  │\x1b[0m \x1b[3mImportant'));
  assert.ok(rendered.includes('\x1b[32m✓ Done'));
  assert.ok(rendered.includes('\x1b[90m○ Pending'));
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

test('approval prompt uses risk title, scoped menu, and wrapped why', () => {
  const rendered = stripAnsi(renderApprovalPrompt({
    tool: 'shell',
    args: { command: 'rm -rf node_modules && npm install' },
    tier: TIERS.SHELL_DANGEROUS,
    why: 'Resetting dependencies after a Node upgrade, but this removes a directory and needs explicit confirmation.',
    width: 82,
  }));
  assert.ok(rendered.includes('DANGEROUS · SHELL-DANGEROUS · shell'));
  assert.ok(rendered.includes('Decision'));
  assert.ok(rendered.includes('stop'));
  assert.ok(rendered.includes('rm -rf node_modules'));
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
  assert.ok(inline.includes('always allow'));

  const trusted = stripAnsi(renderTrustedApproval({
    tool: 'shell',
    args: { command: 'npm test' },
    scope: 'SESSION',
    ruleId: 'shell-test',
  }));
  assert.ok(trusted.includes('pre-approved (session'));
  assert.ok(trusted.includes('rule shell-test'));
});

console.log(`\n  ${passed} passed, 0 failed\n`);
