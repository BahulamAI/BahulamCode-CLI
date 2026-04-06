/**
 * Tests for BM25 search index.
 */

import { BM25Index } from '../src/context/bm25.mjs';
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

console.log('\n\x1b[1mtest-bm25.mjs\x1b[0m\n');

test('tokenize splits text into lowercase terms', () => {
    const tokens = BM25Index.tokenize('Hello World foo_bar');
    assert.deepStrictEqual(tokens, ['hello', 'world', 'foo_bar']);
});

test('build index with 3 documents', () => {
    const idx = new BM25Index();
    idx.buildIndex([
        { id: 'auth.js', text: 'function authenticate user login password token' },
        { id: 'db.js', text: 'function connect database query select insert' },
        { id: 'api.js', text: 'function handle request response api endpoint' },
    ]);
    assert.strictEqual(idx.N, 3);
    assert.ok(idx.avgDl > 0);
});

test('search returns ranked results', () => {
    const idx = new BM25Index();
    idx.buildIndex([
        { id: 'auth.js', text: 'authenticate user login password token session' },
        { id: 'db.js', text: 'database query select insert connection pool' },
        { id: 'api.js', text: 'handle request response api endpoint route' },
    ]);
    const results = idx.search('authenticate login user');
    assert.ok(results.length > 0);
    assert.strictEqual(results[0].id, 'auth.js');
});

test('search for database returns db.js first', () => {
    const idx = new BM25Index();
    idx.buildIndex([
        { id: 'auth.js', text: 'authenticate user login password' },
        { id: 'db.js', text: 'database query select insert connection' },
        { id: 'api.js', text: 'handle request response endpoint' },
    ]);
    const results = idx.search('database query');
    assert.strictEqual(results[0].id, 'db.js');
});

test('empty index returns empty results', () => {
    const idx = new BM25Index();
    const results = idx.search('anything');
    assert.deepStrictEqual(results, []);
});

test('search with no matching terms returns empty', () => {
    const idx = new BM25Index();
    idx.buildIndex([{ id: 'a', text: 'hello world' }]);
    const results = idx.search('zzzzz');
    assert.deepStrictEqual(results, []);
});

test('topK limits results', () => {
    const idx = new BM25Index();
    const docs = Array.from({ length: 20 }, (_, i) => ({ id: `doc${i}`, text: `common term file number ${i}` }));
    idx.buildIndex(docs);
    const results = idx.search('common term', 5);
    assert.strictEqual(results.length, 5);
});

test('toJSON and fromJSON round-trip', () => {
    const idx = new BM25Index();
    idx.buildIndex([
        { id: 'a', text: 'hello world' },
        { id: 'b', text: 'goodbye world' },
    ]);
    const json = idx.toJSON();
    const restored = BM25Index.fromJSON(json);
    assert.strictEqual(restored.N, 2);
    const results = restored.search('hello');
    assert.strictEqual(results[0].id, 'a');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
