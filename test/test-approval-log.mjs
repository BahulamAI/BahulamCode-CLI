/**
 * Approval log redaction tests.
 *
 * approvals.log is an audit trail, not a secret store. These tests cover the
 * common ways secrets appear in approved commands and rejection notes.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApprovalLog, redactSensitive } from '../src/core/approval-log.mjs';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    pass++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    fail++;
  }
}

console.log('\n\x1b[1mtest-approval-log.mjs\x1b[0m\n');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-approval-log-'));
}

function readLog(cwd) {
  return fs.readFileSync(path.join(cwd, '.bahulam', 'approvals.log'), 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test('redacts shell command secret forms', () => {
  assert.equal(redactSensitive('OPENAI_API_KEY=sk-unquoted npm test'), 'OPENAI_API_KEY=REDACTED npm test');
  assert.equal(redactSensitive('OPENAI_API_KEY="sk-double" npm test'), 'OPENAI_API_KEY=REDACTED npm test');
  assert.equal(redactSensitive("OPENAI_API_KEY='sk-single' npm test"), 'OPENAI_API_KEY=REDACTED npm test');
  assert.equal(
    redactSensitive('curl -H "Authorization: Bearer sk-bearer-token" https://x'),
    'curl -H "Authorization: Bearer REDACTED" https://x'
  );
  assert.equal(
    redactSensitive('https://x.test?a=1&api_key=sk-query&b=2'),
    'https://x.test?a=1&api_key=REDACTED&b=2'
  );
});

test('append redacts nested args and reason before writing approvals.log', () => {
  const cwd = tempProject();
  const log = new ApprovalLog({ cwd });
  log.append({
    tier: 'SHELL-MEDIUM',
    tool: 'shell',
    args: { command: 'OPENAI_API_KEY="sk-command" npm test' },
    decision: 'reject',
    reason: 'User denied because TOKEN=secret-reason',
  });
  log.append({
    tier: 'NETWORK',
    tool: 'remote_call',
    args: {
      env: {
        OPENAI_API_KEY: 'sk-json-env',
        ANTHROPIC_API_KEY: 'sk-ant-json',
        SAFE_VALUE: 'visible',
      },
      payload: {
        api_key: 'sk-json-api-key',
        token: 'tok-json',
        nested: [{ password: 'pw-json' }],
      },
      url: 'https://x.test?a=1&api_key=sk-query',
    },
    decision: 'approve',
  });

  const entries = readLog(cwd);
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes('sk-command'));
  assert.ok(!serialized.includes('sk-json-env'));
  assert.ok(!serialized.includes('sk-ant-json'));
  assert.ok(!serialized.includes('sk-json-api-key'));
  assert.ok(!serialized.includes('tok-json'));
  assert.ok(!serialized.includes('pw-json'));
  assert.ok(!serialized.includes('sk-query'));
  assert.ok(!serialized.includes('secret-reason'));
  assert.ok(serialized.includes('SAFE_VALUE'));
  assert.ok(serialized.includes('visible'));
  assert.ok(serialized.includes('REDACTED'));
});

test('append redacts sensitive config content in write_project args', () => {
  const cwd = tempProject();
  const log = new ApprovalLog({ cwd });
  log.append({
    tier: 'PROTECTED-EDIT',
    tool: 'write_project',
    args: {
      files: [
        { path: '.env.local', content: 'BACKEND_API_URL=http://backend-api:8000\nFEATURE=true\n' },
        { path: 'src/app.mjs', content: 'export const visible = true;\n' },
      ],
    },
    decision: 'approve',
  });

  const serialized = JSON.stringify(readLog(cwd));
  assert.ok(!serialized.includes('backend-api:8000'));
  assert.ok(serialized.includes('[redacted sensitive config]'));
  assert.ok(serialized.includes('export const visible = true'));
});

test('approvals.log is created with user-only permissions where supported', () => {
  const cwd = tempProject();
  const log = new ApprovalLog({ cwd });
  log.append({ tier: 'test', tool: 'shell', args: { command: 'echo ok' }, decision: 'approve' });
  const stat = fs.statSync(path.join(cwd, '.bahulam', 'approvals.log'));
  assert.equal(stat.mode & 0o777, 0o600);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
