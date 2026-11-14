/**
 * Regression tests for CheckpointManager durability.
 *
 * These lock in the three properties /undo depends on:
 *   1. a missing source file is the only silent null; real failures surface
 *   2. restore is atomic and does not destroy symlinks
 *   3. checkpoint history survives a process restart
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolated ~/.bahulam so tests never touch the developer's real checkpoints.
const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-ckpt-home-'));
process.env.BAHULAM_HOME = homeRoot;

const { CheckpointManager } = await import('../src/core/checkpoints.mjs');
const { checkpointsDir } = await import('../src/core/paths.mjs');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

function project(name) {
  const dir = fs.mkdtempSync(path.join(homeRoot, `proj-${name}-`));
  return dir;
}

function write(projectDir, name, content) {
  const filePath = path.join(projectDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

await test('missing source file returns null without recording an error', () => {
  const dir = project('missing');
  const mgr = new CheckpointManager(dir);
  const id = mgr.save(path.join(dir, 'does-not-exist.txt'));
  assert.strictEqual(id, null, 'absence is expected, not an error');
  assert.strictEqual(mgr.lastError, null, 'ENOENT must not be reported as a failure');
});

await test('save writes a parseable checkpoint file', () => {
  const dir = project('save');
  const filePath = write(dir, 'a.txt', 'original');
  const mgr = new CheckpointManager(dir);
  const id = mgr.save(filePath);
  assert.ok(id, 'save should return an id for an existing file');

  const ckptFile = path.join(checkpointsDir(dir), `${id}.json`);
  const parsed = JSON.parse(fs.readFileSync(ckptFile, 'utf-8'));
  assert.strictEqual(parsed.filePath, filePath);
  assert.strictEqual(parsed.content, 'original');
  assert.strictEqual(parsed.id, id);
});

await test('undo restores content and consumes the checkpoint', () => {
  const dir = project('undo');
  const filePath = write(dir, 'b.txt', 'before');
  const mgr = new CheckpointManager(dir);
  const id = mgr.save(filePath);

  fs.writeFileSync(filePath, 'after');
  const result = mgr.undo();

  assert.ok(result?.restored, 'undo should report success');
  assert.strictEqual(result.filePath, filePath);
  assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'before');
  assert.ok(!fs.existsSync(path.join(checkpointsDir(dir), `${id}.json`)),
    'checkpoint file should be removed once used');
});

await test('undo preserves file permissions', () => {
  const dir = project('mode');
  const filePath = write(dir, 'run.sh', '#!/bin/sh\necho hi\n');
  fs.chmodSync(filePath, 0o755);

  const mgr = new CheckpointManager(dir);
  mgr.save(filePath);
  fs.writeFileSync(filePath, 'clobbered');

  mgr.undo();
  const mode = fs.statSync(filePath).mode & 0o777;
  assert.strictEqual(mode, 0o755, 'executable bit must survive the restore');
});

await test('undo through a symlink restores the target and keeps the link', () => {
  const dir = project('symlink');
  const real = write(dir, 'real.txt', 'original');
  const link = path.join(dir, 'link.txt');
  fs.symlinkSync(real, link);

  const mgr = new CheckpointManager(dir);
  mgr.save(link);
  fs.writeFileSync(real, 'mutated');

  const result = mgr.undo();
  assert.ok(result?.restored);
  assert.strictEqual(fs.readFileSync(real, 'utf-8'), 'original');
  assert.ok(fs.lstatSync(link).isSymbolicLink(),
    'atomic rename must not replace the symlink with a regular file');
});

await test('history survives a new manager instance (restart)', () => {
  const dir = project('restart');
  const filePath = write(dir, 'c.txt', 'persisted');

  const first = new CheckpointManager(dir);
  const id = first.save(filePath);
  assert.ok(id);

  // Simulate a fresh CLI process: no in-memory history, same disk state.
  const second = new CheckpointManager(dir);
  assert.deepStrictEqual(second.history, [], 'precondition: new instance starts empty');

  const listed = second.list();
  assert.strictEqual(listed.length, 1, 'list should rehydrate from disk');
  assert.strictEqual(listed[0].id, id);

  fs.writeFileSync(filePath, 'changed');
  const result = second.undo();
  assert.ok(result?.restored, 'undo must work across restarts');
  assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'persisted');
});

await test('a broken checkpoint directory reports an error instead of failing silently', () => {
  const dir = project('broken');
  const filePath = write(dir, 'd.txt', 'content');

  // Occupy the checkpoint directory path with a regular file so mkdir fails.
  const ckptDir = checkpointsDir(dir);
  fs.mkdirSync(path.dirname(ckptDir), { recursive: true });
  fs.writeFileSync(ckptDir, 'not a directory');

  const mgr = new CheckpointManager(dir);
  const id = mgr.save(filePath);

  assert.strictEqual(id, null, 'save cannot succeed');
  assert.ok(mgr.lastError, 'a write failure must be recorded, not swallowed');
  assert.match(mgr.lastError, /checkpoint/i);
});

await test('a corrupt checkpoint is reported as unreadable, not faked', () => {
  const dir = project('corrupt');
  const filePath = write(dir, 'e.txt', 'fine');
  const mgr = new CheckpointManager(dir);
  const id = mgr.save(filePath);

  fs.writeFileSync(path.join(checkpointsDir(dir), `${id}.json`), '{ this is not json');

  const fresh = new CheckpointManager(dir);
  const [entry] = fresh.list();
  assert.strictEqual(entry.id, id);
  assert.strictEqual(entry.file, null, 'must not invent a plausible filename');
  assert.strictEqual(entry.timestamp, null, 'must not invent a plausible timestamp');
  assert.ok(entry.unreadable, 'the parse error should be surfaced');
});

await test('undo on an empty manager returns null rather than throwing', () => {
  const dir = project('empty');
  const mgr = new CheckpointManager(dir);
  assert.strictEqual(mgr.undo(), null);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
