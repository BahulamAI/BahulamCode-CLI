import assert from 'node:assert';

import { term, _setForTesting as _setTermForTesting } from '../src/ui/term.mjs';
import * as queue from '../src/ui/render-queue.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

function withCapturedQueue(fn) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalTerm = { ...term() };
  _setTermForTesting({
    isTTY: true,
    color: true,
    colorLevel: 'ansi16',
    plain: false,
    ttyMode: 'rich',
    fixedInput: true,
    columns: 24,
    rows: 12,
  });
  let stdout = '';
  let stderr = '';

  process.stdout.write = function captureStdout(chunk, encoding, cb) {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  };
  process.stderr.write = function captureStderr(chunk, encoding, cb) {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  };

  try {
    assert.strictEqual(queue.activate({ initialRow: 1, initialCol: 1, bottom: 8 }), true);
    fn({ stdout: () => stdout, stderr: () => stderr });
    return { stdout, stderr };
  } finally {
    queue.deactivate();
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    _setTermForTesting(originalTerm);
  }
}

console.log('\n\x1b[1mtest-render-queue.mjs\x1b[0m\n');

test('cellWidth tracks CJK, combining marks, and tabs by terminal cells', () => {
  assert.strictEqual(queue.cellWidth('abc'), 3);
  assert.strictEqual(queue.cellWidth('語'), 2);
  assert.strictEqual(queue.cellWidth('e\u0301'), 1);
  assert.strictEqual(queue.cellWidth('a\tb'), 9);
});

test('redirected content strips split non-SGR CSI cursor commands', () => {
  const { stderr } = withCapturedQueue(() => {
    process.stdout.write('\x1b[99');
    process.stdout.write(';1Hsafe');
  });

  assert.ok(stderr.includes('safe'), stderr);
  assert.ok(!stderr.includes('\x1b[99;1H'), JSON.stringify(stderr));
});

test('redirected content strips split OSC sequences', () => {
  const { stderr } = withCapturedQueue(() => {
    process.stdout.write('\x1b]0;bad');
    process.stdout.write('\x07safe');
  });

  assert.ok(stderr.includes('safe'), stderr);
  assert.ok(!stderr.includes('bad'), JSON.stringify(stderr));
  assert.ok(!stderr.includes('\x1b]0;bad\x07'), JSON.stringify(stderr));
});

test('redirected content preserves split SGR styling sequences', () => {
  const { stderr } = withCapturedQueue(() => {
    process.stdout.write('\x1b[3');
    process.stdout.write('1mred');
    process.stdout.write('\x1b[0');
    process.stdout.write('m');
  });

  assert.ok(stderr.includes('\x1b[31m'), JSON.stringify(stderr));
  assert.ok(stderr.includes('red'), stderr);
  assert.ok(stderr.includes('\x1b[0m'), JSON.stringify(stderr));
});

test('status is cleared before redirected content is appended and then repainted', () => {
  const { stderr } = withCapturedQueue(() => {
    queue.status('spin');
    process.stdout.write('body');
  });

  const firstClear = stderr.indexOf('\x1b[2K');
  const body = stderr.indexOf('body');
  const repaint = stderr.lastIndexOf('spin');
  assert.ok(firstClear >= 0, JSON.stringify(stderr));
  assert.ok(body > firstClear, JSON.stringify(stderr));
  assert.ok(repaint > body, JSON.stringify(stderr));
});

console.log(`\n\x1b[32m${passed} passed\x1b[0m\n`);
