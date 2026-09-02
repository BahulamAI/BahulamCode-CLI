/**
 * Tests for incremental index updates after file writes.
 *
 * Validates that ContextRetriever.updateFile() keeps BM25 fresh
 * when files are created, edited, or deleted during a session.
 */

import { ContextRetriever } from '../src/context/retriever.mjs';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

/** Create a temp project dir with files and a built index. */
function createIndexedProject() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-idx-'));

    // Create source files
    fs.writeFileSync(path.join(tmpDir, 'auth.js'), `
function login(username, password) {
    return verifyCredentials(username, password);
}

function logout(sessionId) {
    return clearSession(sessionId);
}

function verifyCredentials(user, pass) {
    return true;
}
`);

    fs.writeFileSync(path.join(tmpDir, 'database.js'), `
function connectDB(connectionString) {
    return new Connection(connectionString);
}

function executeQuery(sql, params) {
    return db.query(sql, params);
}
`);

    // Build index
    const retriever = new ContextRetriever(tmpDir);
    retriever.buildIndex();

    return { tmpDir, retriever };
}

function cleanup(tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log('\n\x1b[1mtest-index-freshness.mjs\x1b[0m\n');

// ─── Baseline Tests ───

test('search finds existing function in indexed project', () => {
    const { tmpDir, retriever } = createIndexedProject();
    const results = retriever.retrieve('login authentication', 5);
    assert.ok(results.length > 0, 'Expected search results');
    assert.ok(results.some(r => r.id.includes('auth')), `Expected auth.js in results, got: ${results.map(r => r.id)}`);
    cleanup(tmpDir);
});

test('search finds database functions', () => {
    const { tmpDir, retriever } = createIndexedProject();
    const results = retriever.retrieve('database query connection', 5);
    assert.ok(results.some(r => r.id.includes('database')), `Expected database.js in results`);
    cleanup(tmpDir);
});

// ─── Incremental Update Tests ───

test('new function is searchable after updateFile', () => {
    const { tmpDir, retriever } = createIndexedProject();

    // Add a new function
    const authPath = path.join(tmpDir, 'auth.js');
    let content = fs.readFileSync(authPath, 'utf-8');
    content += `
function resetPassword(email) {
    return generateResetToken(email);
}
`;
    fs.writeFileSync(authPath, content);

    // Update index for this file
    retriever.updateFile(authPath);

    // Search should find the new function
    const results = retriever.retrieve('reset password email token', 5);
    const texts = results.map(r => r.text);
    assert.ok(
        texts.some(t => t.includes('resetPassword')),
        `Expected 'resetPassword' in results, got IDs: ${results.map(r => r.id)}`
    );
    cleanup(tmpDir);
});

test('renamed function is searchable after updateFile', () => {
    const { tmpDir, retriever } = createIndexedProject();

    // Rename logout → signOut
    const authPath = path.join(tmpDir, 'auth.js');
    let content = fs.readFileSync(authPath, 'utf-8');
    content = content.replace('function logout(', 'function signOut(');
    fs.writeFileSync(authPath, content);

    retriever.updateFile(authPath);

    const results = retriever.retrieve('signOut session', 5);
    const texts = results.map(r => r.text);
    assert.ok(
        texts.some(t => t.includes('signOut')),
        `Expected 'signOut' in results`
    );
    cleanup(tmpDir);
});

test('deleted file removed from index after updateFile', () => {
    const { tmpDir, retriever } = createIndexedProject();

    // Delete database.js
    const dbPath = path.join(tmpDir, 'database.js');
    fs.unlinkSync(dbPath);

    retriever.updateFile(dbPath);

    // Search for database should return nothing from that file
    const results = retriever.retrieve('database query connection', 5);
    const dbResults = results.filter(r => r.id.includes('database'));
    assert.strictEqual(dbResults.length, 0, `Expected no database.js results, got: ${dbResults.map(r => r.id)}`);
    cleanup(tmpDir);
});

test('new file is searchable after updateFile', () => {
    const { tmpDir, retriever } = createIndexedProject();

    // Create a new file
    const newPath = path.join(tmpDir, 'permissions.js');
    fs.writeFileSync(newPath, `
function check_permission(user_id, resource) {
    return has_access(user_id, resource);
}

function grant_access(user_id, resource, level) {
    return set_permission(user_id, resource, level);
}
`);

    retriever.updateFile(newPath);

    // BM25 tokenizer splits on snake_case, so use snake_case terms
    const results = retriever.retrieve('permission access resource', 5);
    assert.ok(
        results.some(r => r.id.includes('permissions')),
        `Expected permissions.js in results, got: ${results.map(r => r.id)}`
    );
    cleanup(tmpDir);
});

test('multiple sequential updates keep index consistent', () => {
    const { tmpDir, retriever } = createIndexedProject();

    // Edit auth.js — use snake_case for BM25 tokenizer compatibility
    const authPath = path.join(tmpDir, 'auth.js');
    let content = fs.readFileSync(authPath, 'utf-8');
    content += '\nfunction two_factor_auth(code) { return validate(code); }\n';
    fs.writeFileSync(authPath, content);
    retriever.updateFile(authPath);

    // Edit database.js
    const dbPath = path.join(tmpDir, 'database.js');
    let dbContent = fs.readFileSync(dbPath, 'utf-8');
    dbContent += '\nfunction migrate_schema(version) { return run_migration(version); }\n';
    fs.writeFileSync(dbPath, dbContent);
    retriever.updateFile(dbPath);

    // Both new functions should be searchable
    const authResults = retriever.retrieve('factor auth validate', 5);
    assert.ok(authResults.some(r => r.text.includes('two_factor_auth')), 'two_factor_auth not found');

    const dbResults = retriever.retrieve('migrate schema version', 5);
    assert.ok(dbResults.some(r => r.text.includes('migrate_schema')), 'migrate_schema not found');

    cleanup(tmpDir);
});

// ─── Persistence Tests ───

test('updated index persists to disk and reloads', () => {
    const { tmpDir, retriever } = createIndexedProject();

    // Add a function and update
    const authPath = path.join(tmpDir, 'auth.js');
    let content = fs.readFileSync(authPath, 'utf-8');
    content += '\nfunction refreshToken(token) { return newToken(); }\n';
    fs.writeFileSync(authPath, content);
    retriever.updateFile(authPath);

    // Create a fresh retriever (simulates restart) and load from disk
    const fresh = new ContextRetriever(tmpDir);
    const loaded = fresh.loadIndex();
    assert.ok(loaded, 'Failed to load persisted index');

    const results = fresh.retrieve('refresh token', 5);
    assert.ok(
        results.some(r => r.text.includes('refreshToken')),
        'refreshToken not found after reload'
    );
    cleanup(tmpDir);
});

// ─── Performance Tests ───

test('single file updateFile completes under 50ms', () => {
    const { tmpDir, retriever } = createIndexedProject();

    // Add 15 more files to make it realistic
    for (let i = 0; i < 15; i++) {
        const fp = path.join(tmpDir, `service_${i}.js`);
        fs.writeFileSync(fp, `
function handle_${i}(request) { return process_${i}(request); }
function process_${i}(data) { return transform(data); }
class Service_${i} { constructor() {} run() {} }
`);
    }
    retriever.buildIndex(); // Rebuild with all files

    // Time a single file update
    const authPath = path.join(tmpDir, 'auth.js');
    let content = fs.readFileSync(authPath, 'utf-8');
    content += '\nfunction hotNewFunction() { return 42; }\n';
    fs.writeFileSync(authPath, content);

    const start = performance.now();
    retriever.updateFile(authPath);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 50, `updateFile took ${elapsed.toFixed(1)}ms (limit: 50ms)`);
    cleanup(tmpDir);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
