import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'win-slug-')));
process.env.BAHULAM_HOME = home;
const { transcriptProjectSlug } = await import('../src/core/paths.mjs');
const { JsonlWriter } = await import('../src/core/jsonl-writer.mjs');

try {
  // POSIX paths must be unchanged — existing transcripts keep their dirs.
  assert.equal(transcriptProjectSlug('/Users/sree/proj'), '-Users-sree-proj');

  // Windows paths: backslashes + drive colon become a single valid segment.
  const winSlug = transcriptProjectSlug('C:\\Users\\sree\\proj');
  assert.ok(!winSlug.includes('\\'), `slug must not contain backslashes: ${winSlug}`);
  assert.ok(!winSlug.includes(':'), `slug must not contain drive colon: ${winSlug}`);
  assert.ok(!/[<>:"|?*]/.test(winSlug), `slug must be a valid dir segment: ${winSlug}`);
  assert.equal(winSlug, 'C--Users-sree-proj');
  // Writer and reader derive the same slug from the same cwd.
  const writer = new JsonlWriter('C:\\Users\\sree\\proj', '0.0.0-test');
  assert.equal(writer.slug, winSlug);
  // The writer must be able to create its project dir synchronously (no throw).
  const projectDir = path.join(home, 'projects', winSlug);
  assert.ok(fs.existsSync(projectDir), `writer must create its project dir: ${projectDir}`);
  writer.close();

  console.log('PASS: windows project slugs are valid single segments, writer/reader agree, mkdir succeeds.');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}