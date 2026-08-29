/**
 * E2E Smoke Tests — CLI flags, help, version.
 */

import { execSync } from 'node:child_process';
import assert from 'node:assert';

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

console.log('\n\x1b[1me2e-smoke.mjs\x1b[0m\n');

const CLI = 'node src/index.mjs';
const opts = { cwd: process.cwd(), encoding: 'utf-8', timeout: 10_000 };

test('--version prints version', () => {
    const out = execSync(`${CLI} --version`, opts).trim();
    assert.ok(out.includes('@tarang/cli'), `Expected version string, got: ${out}`);
});

test('-V prints version', () => {
    const out = execSync(`${CLI} -V`, opts).trim();
    assert.ok(out.includes('@tarang/cli'));
});

test('--help prints usage', () => {
    const out = execSync(`${CLI} --help`, opts);
    assert.ok(out.includes('USAGE'));
    assert.ok(out.includes('tarang'));
    assert.ok(out.includes('FLAGS'));
});

test('-h prints usage', () => {
    const out = execSync(`${CLI} -h`, opts);
    assert.ok(out.includes('USAGE'));
});

test('config --show works without config file', () => {
    // May show (not set) for unconfigured values — should not crash
    const out = execSync(`${CLI} config --show`, opts);
    assert.ok(out.includes('config_path'));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
