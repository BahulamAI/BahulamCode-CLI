import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { finished } from 'node:stream/promises';
import { BashTool } from '../src/tools/bash.mjs';
import { backgroundTasks } from '../src/core/background-tasks.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function startFixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bahulam-promotion-'));
  const source = path.join(cwd, 'child.cjs');
  await fs.writeFile(source, `
    const fs = require('node:fs');
    fs.appendFileSync('starts', process.pid + '\\n');
    process.stdout.write('before promotion\\n');
    fs.writeFileSync('ready', String(process.pid));
    const timer = setInterval(() => {
      if (!fs.existsSync('release')) return;
      clearInterval(timer);
      process.stderr.write('after promotion\\n');
      process.exitCode = 7;
    }, 10);
  `);
  const abort = new AbortController();
  let promote;
  const result = BashTool.call({ command: `${quote(process.execPath)} ${quote(source)}`, cwd, timeout: 750 }, {
    signal: abort.signal,
    registerBackgroundPromotion: callback => { promote = callback; },
  });
  let job;
  t.after(async () => {
    if (job) { backgroundTasks.kill(job.id); await backgroundTasks.wait(job.id); }
    else { abort.abort(); await result; }
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;
  while (true) {
    try { await fs.access(path.join(cwd, 'ready')); break; } catch {}
    assert.ok(Date.now() < deadline, 'child failed to reach ready state');
    await delay(10);
  }
  job = await promote();
  assert.ok(job?.id);
  assert.match(await result, new RegExp(job.id));
  assert.equal(await promote(), null, 'promotion must be single-use');
  return { cwd, job, abort };
}

test('promotion preserves process, output and nonzero exit after foreground cancellation', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async t => {
  const { cwd, job, abort } = await startFixture(t);
  const childPid = Number(await fs.readFile(path.join(cwd, 'ready'), 'utf8'));
  // The shell may exec Node or retain Node as its child. The marker proves
  // that the same worker continues; starts also detects accidental restarts.
  process.kill(childPid, 0);
  abort.abort();
  assert.equal(backgroundTasks.describe(job.id).status, 'running');
  await delay(900); // outlive the original foreground timeout
  process.kill(childPid, 0);
  await fs.writeFile(path.join(cwd, 'release'), 'go');
  const result = await backgroundTasks.wait(job.id);
  assert.equal(result.pid, job.pid);
  assert.equal(result.status, 'failed');
  assert.equal(result.exit_code, 7);
  assert.match(result.tail, /before promotion/);
  assert.match(result.tail, /after promotion/);
  assert.equal((await fs.readFile(path.join(cwd, 'starts'), 'utf8')).trim(), String(childPid));
  await finished(backgroundTasks.jobs.get(job.id)._logStream);
  const log = await fs.readFile(result.log_path, 'utf8');
  assert.match(log, /before promotion/);
  assert.match(log, /after promotion/);
});

test('stopping an adopted process retains killed status and emits completion once', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async t => {
  const { job } = await startFixture(t);
  const completed = [];
  const unsubscribe = backgroundTasks.onExit(value => { if (value.id === job.id) completed.push(value); });
  t.after(unsubscribe);
  backgroundTasks.kill(job.id);
  const result = await backgroundTasks.wait(job.id);
  assert.equal(result.status, 'killed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, 'killed');
});

test('an adopted job survives output-log failure and reports it in the tail', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async t => {
  const { cwd, job } = await startFixture(t);
  const logStream = backgroundTasks.jobs.get(job.id)._logStream;
  logStream.destroy(new Error('simulated disk failure'));
  await new Promise(resolve => logStream.once('close', resolve));
  await fs.writeFile(path.join(cwd, 'release'), 'go');
  const result = await backgroundTasks.wait(job.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.log_error, 'simulated disk failure');
  assert.match(result.tail, /Background output log unavailable: simulated disk failure/);
  assert.match(result.tail, /after promotion/);
});
