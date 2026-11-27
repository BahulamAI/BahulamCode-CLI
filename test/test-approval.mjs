/**
 * Tests for ApprovalManager.
 */

import { ApprovalManager } from '../src/core/approval.mjs';
import { getTimeoutPolicy, interceptApproval, installApprovalInterceptor, listPending, resolvePending, setTimeoutPolicy, shutdownAllPending } from '../src/daemon/approval-store.mjs';
import assert from 'node:assert';

let passed = 0;
let failed = 0;

function stripAnsi(value) {
    return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
}

async function test(name, fn) {
    try {
        await fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (err) {
        console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
        failed++;
    }
}

console.log('\n\x1b[1mtest-approval.mjs\x1b[0m\n');

await test('read tools auto-approve', async () => {
    const mgr = new ApprovalManager();
    const r = await mgr.check('read_file', { path: 'x.js' });
    assert.strictEqual(r.approved, true);
});

await test('sensitive reads prompt instead of auto-approving', async () => {
    const mgr = new ApprovalManager();
    mgr._readKey = async () => 'n';
    mgr._readLinePrompt = async () => 'contains secrets';

    const originalWrite = process.stderr.write;
    let output = '';
    process.stderr.write = (chunk) => {
        output += String(chunk);
        return true;
    };

    try {
        const r = await mgr.check('read_file', { path: '.env' });
        assert.strictEqual(r.approved, false);
        assert.ok(output.includes('SENSITIVE-READ'));
        assert.ok(output.includes('.env'));
    } finally {
        process.stderr.write = originalWrite;
    }
});

await test('sensitive config writes prompt and redact edit values', async () => {
    const mgr = new ApprovalManager();
    mgr._readKey = async () => 'n';

    const originalWrite = process.stderr.write;
    let output = '';
    process.stderr.write = (chunk) => {
        output += String(chunk);
        return true;
    };

    try {
        const r = await mgr.check('edit_file', {
            file_path: '.env.local',
            search: 'API_KEY=old-secret',
            replace: 'API_KEY=new-secret',
        });
        assert.strictEqual(r.approved, false);
        assert.ok(output.includes('PROTECTED-EDIT'));
        assert.ok(output.includes('.env.local'));
        assert.ok(output.includes('match: [redacted]'));
        assert.ok(output.includes('replace: [redacted]'));
        assert.ok(!output.includes('old-secret'));
        assert.ok(!output.includes('new-secret'));
    } finally {
        process.stderr.write = originalWrite;
    }
});

await test('list_files auto-approves', async () => {
    const mgr = new ApprovalManager();
    const r = await mgr.check('list_files', { pattern: '*' });
    assert.strictEqual(r.approved, true);
});

await test('search_code auto-approves', async () => {
    const mgr = new ApprovalManager();
    const r = await mgr.check('search_code', { pattern: 'foo' });
    assert.strictEqual(r.approved, true);
});

await test('--yes flag approves writes', async () => {
    const mgr = new ApprovalManager({ autoApprove: true });
    const r = await mgr.check('shell', { command: 'rm ~/.agent_framework/.license_lock' });
    assert.strictEqual(r.approved, true);
});

await test('--yes flag does not override hard-blocked shell commands', async () => {
    const mgr = new ApprovalManager({ autoApprove: true });

    const originalWrite = process.stderr.write;
    let output = '';
    process.stderr.write = (chunk) => {
        output += String(chunk);
        return true;
    };

    try {
        const r = await mgr.check('shell', { command: 'rm -rf /' });
        assert.strictEqual(r.approved, false);
        assert.strictEqual(r.blocked, true);
        assert.ok(r.reason.includes('safety policy'));
        assert.ok(output.includes('Blocked by safety policy'));
    } finally {
        process.stderr.write = originalWrite;
    }
});

await test('hard-blocked shell commands skip approval prompt', async () => {
    const mgr = new ApprovalManager();
    let readKeyCalled = false;
    mgr._readKey = async () => {
        readKeyCalled = true;
        return 'y';
    };

    const originalWrite = process.stderr.write;
    let output = '';
    process.stderr.write = (chunk) => {
        output += String(chunk);
        return true;
    };

    try {
        const r = await mgr.check('shell', { command: 'rm -rf /' });
        assert.strictEqual(r.approved, false);
        assert.strictEqual(r.blocked, true);
        assert.strictEqual(readKeyCalled, false);
        assert.ok(!output.includes('Decision'));
    } finally {
        process.stderr.write = originalWrite;
    }
});

await test('hard-blocked shell command message wraps with retry hint', async () => {
    const mgr = new ApprovalManager();

    const originalWrite = process.stderr.write;
    const originalColumns = process.stderr.columns;
    let output = '';
    process.stderr.write = (chunk) => {
        output += String(chunk);
        return true;
    };
    process.stderr.columns = 62;

    try {
        const r = await mgr.check('shell', { command: 'eval $(whoami)' });
        assert.strictEqual(r.approved, false);
        assert.strictEqual(r.blocked, true);
        assert.ok(r.reason.includes('Retry with separate simple shell commands'));
        const lines = stripAnsi(output).split('\n').filter(Boolean);
        assert.ok(lines.length >= 2, 'expected wrapped safety output');
        assert.ok(lines.every(line => line.length <= 62), 'safety output should fit terminal columns');
    } finally {
        process.stderr.write = originalWrite;
        process.stderr.columns = originalColumns;
    }
});

await test('--plan blocks writes', async () => {
    const mgr = new ApprovalManager({ planMode: true });
    const r1 = await mgr.check('shell', { command: 'echo hi' });
    assert.strictEqual(r1.approved, false);
    assert.ok(r1.reason.includes('plan mode'));

    const r2 = await mgr.check('write_file', { path: 'x', content: 'y' });
    assert.strictEqual(r2.approved, false);
});

await test('--plan allows reads', async () => {
    const mgr = new ApprovalManager({ planMode: true });
    const r = await mgr.check('read_file', { path: 'x.js' });
    assert.strictEqual(r.approved, true);
});

await test('approveAll flag works', async () => {
    const mgr = new ApprovalManager();
    mgr.approveAll = true;
    const r = await mgr.check('shell', { command: 'dangerous' });
    assert.strictEqual(r.approved, true);
});

await test('approvedToolTypes works', async () => {
    const mgr = new ApprovalManager();
    mgr.approvedToolTypes.add('shell');
    const r = await mgr.check('shell', { command: 'echo' });
    assert.strictEqual(r.approved, true);

    // Other write tools still need approval (but auto-approve via non-TTY)
    const r2 = await mgr.check('delete_file', { path: 'x' });
    // non-TTY auto-approves in _readChar
    assert.strictEqual(r2.approved, true);
});

await test('get_file_info auto-approves (not a write tool)', async () => {
    const mgr = new ApprovalManager();
    const r = await mgr.check('get_file_info', { path: 'x' });
    assert.strictEqual(r.approved, true);
});

await test('approval prompt shows action, target, risk, and reason', async () => {
    const mgr = new ApprovalManager();
    mgr._readKey = async () => 'n';

    const originalWrite = process.stderr.write;
    let output = '';
    process.stderr.write = (chunk) => {
        output += String(chunk);
        return true;
    };

    try {
        const result = await mgr.check(
            'shell',
            { command: 'npm publish' },
            true,
            { risk: 'high', reason: 'Publishes this package publicly' },
        );
        assert.strictEqual(result.approved, false);
        assert.ok(output.includes('approval') || output.includes('Decision'),
          'expected approval prompt header');
        // v2.0.3: tool label is present-progressive "Running" (was "Run command").
        assert.ok(output.includes('Running') || output.includes('Run command'),
          'expected Running or Run command label');
        assert.ok(output.includes('npm publish'));
        assert.ok(/SHELL-(MEDIUM|DANGEROUS)/.test(output),
          'expected SHELL-MEDIUM or SHELL-DANGEROUS tier label');
        assert.ok(output.includes('[t] allow similar'));
        assert.ok(output.includes('[n] cancel'));
        assert.ok(!output.includes('[?] why'));
        assert.ok(!output.includes('re-plan'));
        assert.ok(output.includes('Publishes this package publicly'));
    } finally {
        process.stderr.write = originalWrite;
    }
});

await test('approval approve once does not print duplicate confirmation', async () => {
    const mgr = new ApprovalManager();
    mgr._readKey = async () => 'y';

    const originalWrite = process.stderr.write;
    let output = '';
    process.stderr.write = (chunk) => {
        output += String(chunk);
        return true;
    };

    try {
        const result = await mgr.check('shell', { command: 'npm publish' });
        assert.strictEqual(result.approved, true);
        assert.ok(output.includes('Decision'));
        assert.ok(output.includes('approved once'));
        assert.ok(!output.includes('approved once · npm publish'));
    } finally {
        process.stderr.write = originalWrite;
    }
});

await test('approval cancel does not prompt for a reason', async () => {
    const mgr = new ApprovalManager();
    let prompted = false;
    mgr._readKey = async () => 'n';
    mgr._readLinePrompt = async () => {
        prompted = true;
        return 'should not be requested';
    };

    const result = await mgr.check('shell', { command: 'npm publish' });
    assert.strictEqual(result.approved, false);
    assert.strictEqual(prompted, false);
    assert.ok(result.reason.includes('stopped'));
});

await test('hold timeout policy keeps Rust-hosted approval pending until a decision', async () => {
    const original = getTimeoutPolicy();
    const emitted = [];
    setTimeoutPolicy({ mode: 'hold' });
    try {
        const approval = interceptApproval(async () => assert.fail('remote approval must not open local prompt'), {
            tool: 'shell', args: { command: 'npm test' }, remoteOnly: true,
            emit: (type, data) => emitted.push({ type, data }),
        });
        const request = emitted.find(event => event.type === 'approval_required');
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(listPending().some(entry => entry.apr_id === request.data.apr_id));
        assert.equal(emitted.some(event => event.type === 'approval_decided'), false);
        assert.equal(resolvePending('deny', request.data.apr_id, 'rust-test'), true);
        assert.equal((await approval).approved, false);
    } finally {
        setTimeoutPolicy(original);
    }
});

await test('configured deny timeout resolves a remote approval and clears pending state', async () => {
    const original = getTimeoutPolicy();
    const emitted = [];
    setTimeoutPolicy({ mode: 'deny', durationSec: 0.02 });
    const keepProcessAlive = setTimeout(() => {}, 1000);
    try {
        const approval = interceptApproval(async () => assert.fail('remote approval must not open local prompt'), {
            tool: 'shell', args: { command: 'npm test' }, remoteOnly: true,
            emit: (type, data) => emitted.push({ type, data }),
        });
        const result = await approval;
        assert.equal(result.approved, false);
        assert.equal(emitted.find(event => event.type === 'approval_decided')?.data.decided_by, 'timeout');
        assert.equal(listPending().length, 0);
    } finally {
        clearTimeout(keepProcessAlive);
        setTimeoutPolicy(original);
    }
});

await test('approval intercept follows the active session and replacement manager', async () => {
    let sessionId = 'session-one';
    let enabled = true;
    const emitted = [];
    const options = {
        sessionId: () => sessionId,
        enabled: () => enabled,
        emit: (type, data, id) => emitted.push({ type, data, id }),
    };
    const manager = { check: async () => new Promise(() => {}) };
    assert.strictEqual(installApprovalInterceptor(manager, options), true);
    assert.strictEqual(installApprovalInterceptor(manager, options), false);
    const first = manager.check('shell', { command: 'npm test' });
    const request = emitted.find(event => event.type === 'approval_required');
    assert.strictEqual(request.id, 'session-one');
    assert.strictEqual(resolvePending('approve', request.data.apr_id, 'desktop'), true);
    assert.strictEqual((await first).approved, true);

    sessionId = 'session-two';
    const replacement = { check: async () => new Promise(() => {}) };
    installApprovalInterceptor(replacement, options);
    const second = replacement.check('shell', { command: 'npm run build' });
    const secondRequest = emitted.filter(event => event.type === 'approval_required').at(-1);
    assert.strictEqual(secondRequest.id, 'session-two');
    assert.strictEqual(resolvePending('deny', secondRequest.data.apr_id, 'mobile'), true);
    assert.strictEqual((await second).approved, false);

    enabled = false;
    const local = { check: async () => ({ approved: true }) };
    installApprovalInterceptor(local, options);
    assert.strictEqual((await local.check('shell', {})).approved, true);
    assert.strictEqual(listPending().length, 0);
    shutdownAllPending();
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
