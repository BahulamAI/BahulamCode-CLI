import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendVisionAnalysisToInstruction,
  appendDocumentsToInstruction,
  loadClipboardImageAttachment,
  loadDocumentAttachment,
  parseAttachmentReferences,
  parseImageReferences,
  prepareDocumentAttachments,
  prepareImageAttachments,
  publicAttachmentMetadata,
  publicDocumentMetadata,
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

// ── Document attachments (client-side inline extraction) ──────────────

function asyncTest(name, fn) {
  return fn().then(
    () => { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; },
    (err) => { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`); failed++; },
  );
}

const docTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-doc-att-'));

await asyncTest('parseAttachmentReferences splits image + doc refs', () => {
  const parsed = parseAttachmentReferences(
    'compare @/tmp/foo.png with @/tmp/notes.md and check @/tmp/data.csv',
    { cwd: '/tmp' },
  );
  assert.strictEqual(parsed.images.length, 1, 'expected 1 image');
  assert.strictEqual(parsed.documents.length, 2, 'expected 2 documents');
  assert.strictEqual(parsed.images[0].path, '/tmp/foo.png');
  assert.deepStrictEqual(
    parsed.documents.map(d => d.path).sort(),
    ['/tmp/data.csv', '/tmp/notes.md'],
  );
  // Refs stripped from instruction.
  assert.ok(!parsed.instruction.includes('@'), 'instruction should have no @refs');
  return Promise.resolve();
});

await asyncTest('parseAttachmentReferences recognises @clipboard as an image ref (falls back gracefully)', () => {
  // We can't guarantee the clipboard has an image on the test runner,
  // so we accept EITHER: (a) it resolved to a temp path (rare but ok),
  // or (b) it was skipped with a stderr warning and no ref was added.
  // Both paths mean parsing didn't crash and the @token was consumed.
  const parsed = parseAttachmentReferences('explain @clipboard');
  assert.ok(!parsed.instruction.includes('@clipboard'),
    '@clipboard token should be consumed from the instruction regardless of outcome');
  assert.ok(parsed.images.length <= 1, 'at most one clipboard image');
  if (parsed.images.length === 1) {
    assert.strictEqual(parsed.images[0].source, 'clipboard');
  }
  return Promise.resolve();
});

await asyncTest('parseAttachmentReferences recognizes common doc extensions', () => {
  const parsed = parseAttachmentReferences(
    '@a.txt @b.md @c.mdx @d.csv @e.json @f.yaml @g.toml @h.log @i.rst @j.pdf',
  );
  assert.strictEqual(parsed.documents.length, 10, 'expected 10 doc refs recognized');
  return Promise.resolve();
});

await asyncTest('loadDocumentAttachment reads a plain markdown file', async () => {
  const p = path.join(docTmp, 'notes.md');
  fs.writeFileSync(p, '# Title\n\nHello **world**.\n');
  const doc = await loadDocumentAttachment(p);
  assert.strictEqual(doc.name, 'notes.md');
  assert.strictEqual(doc.kind, 'text');
  assert.strictEqual(doc.ext, '.md');
  assert.ok(doc.text.includes('Hello **world**'));
  assert.strictEqual(doc.truncated, false);
  assert.ok(doc.sha256 && doc.sha256.length === 64);
});

await asyncTest('loadDocumentAttachment truncates long text with maxChars', async () => {
  const p = path.join(docTmp, 'big.txt');
  fs.writeFileSync(p, 'x'.repeat(1000));
  const doc = await loadDocumentAttachment(p, { maxChars: 100 });
  assert.strictEqual(doc.text.length, 100);
  assert.strictEqual(doc.truncated, true);
});

await asyncTest('loadDocumentAttachment rejects oversized files', async () => {
  const p = path.join(docTmp, 'huge.txt');
  fs.writeFileSync(p, 'a'.repeat(2000));
  await assert.rejects(
    () => loadDocumentAttachment(p, { maxBytes: 1000 }),
    /exceeds .* cap/,
  );
});

await asyncTest('loadDocumentAttachment handles missing file with clear error', async () => {
  await assert.rejects(
    () => loadDocumentAttachment('/tmp/definitely-not-here-xyz.md'),
    /Document not found/,
  );
});

await asyncTest('prepareDocumentAttachments extracts referenced files + returns metadata', async () => {
  const p1 = path.join(docTmp, 'one.md');
  const p2 = path.join(docTmp, 'two.txt');
  fs.writeFileSync(p1, 'first doc');
  fs.writeFileSync(p2, 'second doc');
  const out = await prepareDocumentAttachments(
    `explain @${p1} and @${p2}`,
    { cwd: docTmp },
  );
  assert.strictEqual(out.documents.length, 2);
  const names = out.documents.map(d => d.name).sort();
  assert.deepStrictEqual(names, ['one.md', 'two.txt']);
  assert.ok(!out.instruction.includes('@'), '@refs stripped from instruction');
  assert.strictEqual(out.metadata.length, 2, 'public metadata included');
  assert.ok(!('text' in out.metadata[0]), 'public metadata does NOT include text body');
});

await asyncTest('prepareDocumentAttachments enforces per-turn char cap', async () => {
  const p = path.join(docTmp, 'over.md');
  fs.writeFileSync(p, 'x'.repeat(500));
  await assert.rejects(
    () => prepareDocumentAttachments(`summarize @${p}`, {
      cwd: docTmp, maxDocChars: 500, maxTurnDocChars: 100,
    }),
    /exceeds per-turn cap/,
  );
});

await asyncTest('appendDocumentsToInstruction folds text into a bounded block', async () => {
  const p = path.join(docTmp, 'note.md');
  fs.writeFileSync(p, '# Heading\n\nBody line.\n');
  const doc = await loadDocumentAttachment(p);
  const out = appendDocumentsToInstruction('summarize', [doc]);
  assert.ok(out.startsWith('summarize'), 'instruction preserved');
  assert.ok(out.includes('[Attached document: note.md]'), 'block header present');
  assert.ok(out.includes('# Heading') && out.includes('Body line.'), 'content inlined');
});

await asyncTest('appendDocumentsToInstruction shows page + truncation metadata', async () => {
  // Synthesize a doc object matching the shape loadDocumentAttachment returns.
  const doc = {
    name: 'contract.pdf', kind: 'pdf', pages: 42, chars: 80_000,
    truncated: true, text: 'first page…',
  };
  const out = appendDocumentsToInstruction('review', [doc]);
  assert.ok(out.includes('42 pages'), 'page count surfaced');
  assert.ok(out.includes('truncated'), 'truncation flag surfaced');
});

await asyncTest('publicDocumentMetadata drops text body', () => {
  const meta = publicDocumentMetadata({
    id: 'x', name: 'foo.md', path: '/tmp/foo.md', ext: '.md', kind: 'text',
    bytes: 20, chars: 20, pages: 0, truncated: false, sha256: 'abc',
    text: 'SECRET CONTENT',
  });
  assert.ok(!('text' in meta), 'text field stripped');
  assert.strictEqual(meta.name, 'foo.md');
  return Promise.resolve();
});

// Clean up.
try { fs.rmSync(docTmp, { recursive: true, force: true }); } catch {}

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
