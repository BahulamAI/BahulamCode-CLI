/**
 * Tests for mode selector — classification + probe.
 */

import { selectMode, classifyTask, probeBackend, resetProbeCache } from '../src/core/mode-selector.mjs';
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

console.log('\n\x1b[1mtest-mode-selector.mjs\x1b[0m\n');

// Task classification
await test('classifyTask: explain → simple', async () => {
    assert.strictEqual(classifyTask('explain the auth module'), 'simple');
});

await test('classifyTask: describe → simple', async () => {
    assert.strictEqual(classifyTask('describe how the API works'), 'simple');
});

await test('classifyTask: add authentication → complex', async () => {
    assert.strictEqual(classifyTask('add authentication system'), 'complex');
});

await test('classifyTask: implement database → complex', async () => {
    assert.strictEqual(classifyTask('implement database migration'), 'complex');
});

await test('classifyTask: fix bug → medium', async () => {
    assert.strictEqual(classifyTask('fix the login bug'), 'medium');
});

await test('classifyTask: empty → simple', async () => {
    assert.strictEqual(classifyTask(''), 'simple');
});

// Mode selection with explicit flags
await test('--local flag → local', async () => {
    const mode = await selectMode('anything', { local: true }, {});
    assert.strictEqual(mode, 'local');
});

await test('--remote flag → remote', async () => {
    const mode = await selectMode('anything', { remote: true }, {});
    assert.strictEqual(mode, 'remote');
});

// Backend probe (against non-existent server)
await test('probe unreachable backend → false', async () => {
    resetProbeCache();
    const result = await probeBackend('http://127.0.0.1:1');
    assert.strictEqual(result, false);
});

// Auto mode with no backend → local
await test('auto + backend down → local', async () => {
    resetProbeCache();
    const mode = await selectMode('add auth', {}, { backendUrl: 'http://127.0.0.1:1', mode: 'auto' });
    assert.strictEqual(mode, 'local');
});

// Config default mode
await test('config mode=local → local', async () => {
    const mode = await selectMode('anything', {}, { mode: 'local' });
    assert.strictEqual(mode, 'local');
});

await test('config mode=remote → remote', async () => {
    const mode = await selectMode('anything', {}, { mode: 'remote' });
    assert.strictEqual(mode, 'remote');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
