import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendVisionAnalysisToInstruction,
  loadClipboardImageAttachment,
  parseImageReferences,
  prepareImageAttachments,
  publicAttachmentMetadata,
  writeClipboardImageToTemp,
} from '../src/core/attachments.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
    failed++;
  }
}

function writePng(filePath) {
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
  );
  fs.writeFileSync(filePath, png1x1);
}

console.log('\n\x1b[1mtest-attachments.mjs\x1b[0m\n');

test('parses inline image references and removes path from instruction', () => {
  const parsed = parseImageReferences('compare @"Screen Shot.png" with the code', { cwd: '/tmp' });
  assert.strictEqual(parsed.references.length, 1);
  assert.strictEqual(parsed.references[0].path, '/tmp/Screen Shot.png');
  assert.strictEqual(parsed.instruction, 'compare with the code');
});

test('loads image metadata without exposing base64 in public metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-vision-'));
  const file = path.join(dir, 'one.png');
  writePng(file);

  const prepared = prepareImageAttachments(`@${file} explain this`, { cwd: dir });
  assert.strictEqual(prepared.attachments.length, 1);
  assert.strictEqual(prepared.attachments[0].mime_type, 'image/png');
  assert.strictEqual(prepared.attachments[0].width, 1);
  assert.strictEqual(prepared.attachments[0].height, 1);
  assert.ok(prepared.attachments[0].data_base64);

  const publicMeta = publicAttachmentMetadata(prepared.attachments[0]);
  assert.strictEqual(publicMeta.data_base64, undefined);
  assert.strictEqual(publicMeta.name, 'one.png');
});

test('imports clipboard image through explicit macOS clipboard command path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-clipboard-test-'));
  const runner = (command, args) => {
    assert.strictEqual(command, 'pngpaste');
    writePng(args[0]);
    return '';
  };

  const filePath = writeClipboardImageToTemp({ baseDir: dir, runner, platform: 'darwin' });
  assert.ok(filePath.endsWith('.png'));
  assert.ok(fs.existsSync(filePath));

  const attachment = loadClipboardImageAttachment({ baseDir: dir, runner, platform: 'darwin' });
  assert.strictEqual(attachment.source, 'clipboard');
  assert.strictEqual(attachment.mime_type, 'image/png');
  assert.strictEqual(publicAttachmentMetadata(attachment).source, 'clipboard');
});

test('imports clipboard image through explicit Windows clipboard command path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-clipboard-test-'));
  const runner = (command, args) => {
    assert.strictEqual(command, 'powershell.exe');
    assert.deepStrictEqual(args.slice(0, 3), ['-NoProfile', '-Sta', '-Command']);
    assert.ok(args[3].includes('System.Windows.Forms.Clipboard'));
    const outMatch = args[3].match(/\$out = '([^']+)'/);
    assert.ok(outMatch, args[3]);
    writePng(outMatch[1]);
    return `${outMatch[1]}\r\n`;
  };

  const attachment = loadClipboardImageAttachment({ baseDir: dir, runner, platform: 'win32' });
  assert.strictEqual(attachment.source, 'clipboard');
  assert.strictEqual(attachment.mime_type, 'image/png');
  assert.strictEqual(publicAttachmentMetadata(attachment).source, 'clipboard');
});

test('clipboard image import explains unsupported platform fallback', () => {
  assert.throws(
    () => writeClipboardImageToTemp({ platform: 'linux' }),
    /supported on macOS and Windows/,
  );
});

test('appends vision analysis as text-only surgeon context', () => {
  const out = appendVisionAnalysisToInstruction('fix the button', {
    summary: 'The button appears too narrow and is missing left padding.',
    attachments: [{ name: 'button.png', mime_type: 'image/png', width: 1, height: 1, sha256: 'abcdef1234567890' }],
  });
  assert.ok(out.includes('[Vision analysis]'));
  assert.ok(out.includes('The primary coding agent does not receive raw image pixels'));
  assert.ok(out.includes('missing left padding'));
  assert.ok(!out.includes('data:image'));
});

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
