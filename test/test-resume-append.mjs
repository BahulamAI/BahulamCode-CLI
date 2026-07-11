import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { JsonlWriter } from '../src/core/jsonl-writer.mjs';
import { getSessionDetail, buildResumeHistory } from '../src/core/local-store.mjs';

/**
 * Contract test — the /resume flow keeps using the same sessionId file, appends
 * new turns to that file, and never re-writes the historical entries during
 * activation. (Per PRD-068 §5.14 clarification.)
 */

function makeTempKeplerHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-resume-'));
  process.env.KEPLER_HOME = dir;
  return dir;
}

async function readTranscript(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('resume: new turns append to the same session file (no fork)', async () => {
  const home = makeTempKeplerHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-project-'));

  // 1. Seed the "original" session with two turns.
  const seedWriter = new JsonlWriter(cwd, 'test-v1');
  seedWriter.setSessionId('abc-seed');
  seedWriter.writeUserTurn('first user turn');
  seedWriter.accumulateContent('first assistant reply');
  seedWriter.setTurnUsage({ input_tokens: 100, output_tokens: 50 }, 'test-model');
  seedWriter.flushAssistantTurn();
  await seedWriter.close();

  const seedPath = seedWriter._transcriptPath;
  assert.ok(seedPath && fs.existsSync(seedPath), 'seed transcript exists');
  const seedLines = (await readTranscript(seedPath)).length;

  // 2. Simulate resume: caller creates a fresh writer targeting the SAME id.
  const resumeWriter = new JsonlWriter(cwd, 'test-v1');
  resumeWriter.setSessionId('abc-seed');

  // Same path as before.
  assert.equal(resumeWriter._transcriptPath, seedPath, 'resume writer points at the same file');

  // 3. Write a new user turn after resume.
  resumeWriter.writeUserTurn('second user turn (post-resume)');
  resumeWriter.accumulateContent('second assistant reply (post-resume)');
  resumeWriter.setTurnUsage({ input_tokens: 200, output_tokens: 100 }, 'test-model');
  resumeWriter.flushAssistantTurn();
  await resumeWriter.close();

  // 4. Assert: file grew by exactly one user + one assistant entry — no
  //           historical entries got re-written.
  const afterLines = await readTranscript(seedPath);
  assert.equal(afterLines.length, seedLines + 2,
    'exactly two new lines added; no historical re-write');
  assert.ok(afterLines.some(o => o.type === 'user' && o.message?.content === 'first user turn'), 'original user turn preserved');
  assert.ok(afterLines.some(o => o.type === 'user' && o.message?.content === 'second user turn (post-resume)'), 'new user turn appended');
  assert.equal(afterLines.filter(o => o.type === 'user' && o.message?.content === 'first user turn').length, 1,
    'no duplication of the original user turn');
});

test('resume: fresh kepler start (no resume) mints a NEW session id', async () => {
  const home = makeTempKeplerHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-project-'));

  // Seed one session so we can be sure a "fresh start" doesn't pick it up.
  const seed = new JsonlWriter(cwd, 'test-v1');
  seed.setSessionId('previous-session');
  seed.writeUserTurn('leftover from a prior kepler run');
  await seed.close();

  const seedPath = seed._transcriptPath;
  const seedLinesBefore = (await readTranscript(seedPath)).length;

  // A brand-new writer with no explicit setSessionId gets a fresh UUID
  // the first time writeUserTurn runs.
  const fresh = new JsonlWriter(cwd, 'test-v1');
  fresh.writeUserTurn('fresh session first turn');
  await fresh.close();

  assert.ok(fresh.sessionId, 'fresh writer got a sessionId');
  assert.notEqual(fresh.sessionId, 'previous-session', 'fresh session id is NOT the prior one');
  assert.notEqual(fresh._transcriptPath, seedPath, 'fresh session writes to a different file');

  // Prior session file is untouched.
  const seedLinesAfter = (await readTranscript(seedPath)).length;
  assert.equal(seedLinesAfter, seedLinesBefore, 'previous session file was not mutated');
});

test('resume: loaded transcript is not appended back at activation time', async () => {
  const home = makeTempKeplerHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-project-'));

  const w = new JsonlWriter(cwd, 'test-v1');
  w.setSessionId('activation-test');
  w.writeUserTurn('u1');
  w.accumulateContent('a1');
  w.setTurnUsage({ input_tokens: 10, output_tokens: 5 }, 'm');
  w.flushAssistantTurn();
  w.writeUserTurn('u2');
  w.accumulateContent('a2');
  w.setTurnUsage({ input_tokens: 20, output_tokens: 10 }, 'm');
  w.flushAssistantTurn();
  await w.close();

  const filePath = w._transcriptPath;
  const beforeLines = await readTranscript(filePath);

  // Read the transcript back (simulating the load path in
  // activateResumedSession). This exercises getSessionDetail +
  // buildResumeHistory — the two calls that consume the file.
  const detail = await getSessionDetail('activation-test', { filePath });
  assert.ok(detail, 'transcript reloadable');
  const history = buildResumeHistory({ ...detail, recapTailTurns: 8 }, 'full');
  assert.ok(history.displayHistory.length > 0, 'displayHistory built from the file');

  // Assert: the load produced NO additional lines on disk.
  const afterLines = await readTranscript(filePath);
  assert.equal(afterLines.length, beforeLines.length,
    'activation-time load does not mutate the transcript');
});
