import assert from 'node:assert';
import { c, renderMarkdown, renderDiff, stripAnsi } from '../src/terminal/ansi.mjs';
import { formatShellCommand, toolDisplayLabel, toolDisplaySummary } from '../src/terminal/tool-display.mjs';

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

console.log('\n\x1b[1mtest-terminal-rendering.mjs\x1b[0m\n');

test('Kepler branding stays cyan and code uses bright blue', () => {
  assert.ok(c.brand('kepler').startsWith('\x1b[36m'));
  assert.ok(c.cyan('code').startsWith('\x1b[94m'));
});

test('uses bright white for user labels and underlined links', () => {
  assert.ok(c.white('You').startsWith('\x1b[97m'));
  const rendered = renderMarkdown('[Documentation](https://example.com)');
  assert.ok(rendered.includes('\x1b[4m'));
  assert.ok(rendered.includes('\x1b[97mDocumentation'));
});

test('uses action descriptions instead of raw tool identifiers', () => {
  assert.strictEqual(toolDisplayLabel('shell'), 'Run command');
  assert.strictEqual(toolDisplayLabel('read_file'), 'Read file');
  assert.strictEqual(toolDisplayLabel('search_files'), 'Search files');
  assert.strictEqual(toolDisplayLabel('mcp_fetch_weather'), 'Fetch weather');
  assert.strictEqual(toolDisplayLabel('verify'), 'Verify implementation');
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

test('renders shell commands with blue, yellow, red, and white syntax colors', () => {
  const rendered = formatShellCommand('python -c "print(1)" | head -1', c);
  assert.ok(rendered.includes('\x1b[34mpython'));
  assert.ok(rendered.includes('\x1b[33m-c'));
  assert.ok(rendered.includes('\x1b[33m"print(1)"'));
  assert.ok(rendered.includes('\x1b[31m|'));
  assert.ok(rendered.includes('\x1b[34mhead'));
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
  const rendered = renderMarkdown('```yaml\nstatus: ready\n```');
  assert.ok(rendered.includes('\x1b[1;36mstatus'));
  assert.ok(rendered.includes('\x1b[36m ready'));
});

test('renders diff additions and removals with semantic colors', () => {
  const rendered = renderDiff('@@ -1 +1 @@\n-old\n+new');
  assert.ok(rendered.includes('\x1b[31m-old'));
  assert.ok(rendered.includes('\x1b[32m+new'));
});

console.log(`\n  ${passed} passed, 0 failed\n`);
