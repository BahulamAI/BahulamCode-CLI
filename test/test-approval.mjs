/**
 * Tests for ApprovalManager.
 */

import { ApprovalManager } from '../src/core/approval.mjs';
import assert from 'node:assert';

let passed = 0;
let failed = 0;

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
        assert.ok(output.includes('[t] always allow'));
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
        assert.ok(!output.includes('✓'));
        assert.ok(!output.includes('npm publish\n\n'));
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

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
