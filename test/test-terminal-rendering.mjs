import assert from 'node:assert';
import { c, renderMarkdown, renderDiff, stripAnsi } from '../src/terminal/ansi.mjs';

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

console.log('\n\x1b[1mtest-terminal-rendering.mjs\x1b[0m\n');

test('Orca branding stays cyan and code uses bright blue', () => {
  assert.ok(c.brand('orca').startsWith('\x1b[36m'));
  assert.ok(c.cyan('code').startsWith('\x1b[94m'));
});

test('uses bright white for user labels and underlined links', () => {
  assert.ok(c.white('You').startsWith('\x1b[97m'));
  const rendered = renderMarkdown('[Documentation](https://example.com)');
  assert.ok(rendered.includes('\x1b[4m'));
  assert.ok(rendered.includes('\x1b[97mDocumentation'));
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

test('renders blockquotes and task lists distinctly', () => {
  const rendered = stripAnsi(renderMarkdown('> Important\n- [x] Done\n- [ ] Pending'));
  assert.ok(rendered.includes('▌ Important'));
  assert.ok(rendered.includes('✓ Done'));
  assert.ok(rendered.includes('○ Pending'));
});

test('renders diff additions and removals with semantic colors', () => {
  const rendered = renderDiff('@@ -1 +1 @@\n-old\n+new');
  assert.ok(rendered.includes('\x1b[31m-old'));
  assert.ok(rendered.includes('\x1b[32m+new'));
});

console.log(`\n  ${passed} passed, 0 failed\n`);
