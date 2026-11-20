/**
 * Tests for the cross-language reference graph (graph-indexer.mjs).
 *
 * Mirrors test-index-freshness.mjs style: temp dirs, a createIndexedProject()
 * helper, a tiny test runner, passed/failed counters.
 */

import { ContextRetriever } from '../src/context/retriever.mjs';
import { GraphIndexer, MAX_GRAPH_SOURCE_BYTES } from '../src/context/graph-indexer.mjs';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

async function createProject(files) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-index-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return tmp;
}

function write(dir, rel, content) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
}

function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function absList(dir, files) {
    return Object.keys(files).map(rel => path.join(dir, rel));
}

console.log('\n\x1b[1mtest-graph-index.mjs\x1b[0m\n');

// ── 1. Target-file rename with unchanged importer ─────────────────────────
await test('importer untouched, target renamed → stale edge dropped and marked unresolved', async () => {
    const dir = await createProject({
        'a.js': "import { b } from './b';\n",
        'b.js': "export const b = 1;\n",
    });
    const idx = new GraphIndexer(dir);
    await idx.buildGraph(absList(dir, { 'a.js': '', 'b.js': '' }));

    assert.deepStrictEqual(idx.getImporters('b.js').map(e => e.from), ['a.js']);

    // rename b.js -> c.js: update on b (deleted) must re-resolve importers
    fs.renameSync(path.join(dir, 'b.js'), path.join(dir, 'c.js'));
    idx.updateFile('b.js', { content: null });
    idx.updateFile('c.js', { content: "export const b = 1;\n" });

    // The importer is untouched, so './b' no longer resolves. The reverse
    // index must have dropped the stale edge and surfaced the break.
    assert.deepStrictEqual(idx.getImporters('b.js'), []);
    assert.deepStrictEqual(idx.getImporters('c.js').map(e => e.from), []);
    const imp = idx.getImports('a.js');
    assert.strictEqual(imp.length, 1, 'a.js still records its import');
    assert.strictEqual(imp[0].status, 'unresolved', "a.js's './b' is now unresolved");
    cleanup(dir);
});

// ── 2. New file resolves previously-unresolved import ─────────────────────
await test('new file resolves a previously-unresolved import', async () => {
    const dir = await createProject({
        'a.js': "import { x } from './newmod';\n",
    });
    const idx = new GraphIndexer(dir);
    await idx.buildGraph(absList(dir, { 'a.js': '' }));

    const before = idx.getImports('a.js');
    assert.strictEqual(before.length, 1);
    assert.strictEqual(before[0].status, 'unresolved');

    write(dir, 'newmod.js', "export const x = 1;\n");
    idx.updateFile('newmod.js', { content: "export const x = 1;\n" });

    const after = idx.getImports('a.js');
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].status, 'resolved');
    assert.strictEqual(after[0].to, 'newmod.js');
    cleanup(dir);
});

// ── 3. Two packages use the same alias for different targets ──────────────
await test('two packages resolve the same @/ alias differently', async () => {
    const dir = await createProject({
        'packages/frontend/tsconfig.json': JSON.stringify({
            compilerOptions: { paths: { '@/*': ['./src/*'] } },
        }),
        'packages/frontend/src/x.ts': 'export const f = 1;\n',
        'packages/frontend/app.ts': "import { f } from '@/x';\n",
        'packages/backend/tsconfig.json': JSON.stringify({
            compilerOptions: { paths: { '@/*': ['./lib/*'] } },
        }),
        'packages/backend/lib/x.ts': 'export const b = 1;\n',
        'packages/backend/app.ts': "import { b } from '@/x';\n",
    });
    const idx = new GraphIndexer(dir);
    await idx.buildGraph(absList(dir, Object.fromEntries(Object.keys({
        'packages/frontend/tsconfig.json': '', 'packages/frontend/src/x.ts': '',
        'packages/frontend/app.ts': '', 'packages/backend/tsconfig.json': '',
        'packages/backend/lib/x.ts': '', 'packages/backend/app.ts': '',
    }).map(k => [k, '']))));

    const front = idx.getImports('packages/frontend/app.ts');
    const back = idx.getImports('packages/backend/app.ts');
    assert.strictEqual(front[0].to, 'packages/frontend/src/x.ts');
    assert.strictEqual(back[0].to, 'packages/backend/lib/x.ts');
    assert.notStrictEqual(front[0].to, back[0].to);
    cleanup(dir);
});

// ── 4. Config change redirects an import without editing the importer ─────
await test('tsconfig change redirects alias without touching importer', async () => {
    const dir = await createProject({
        'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./old/*'] } } }),
        'old/orig.ts': 'export const o = 1;\n',
        'new/orig.ts': 'export const n = 1;\n',
        'app.ts': "import { o } from '@/orig';\n",
    });
    const idx = new GraphIndexer(dir);
    await idx.buildGraph(absList(dir, {
        'tsconfig.json': '', 'old/orig.ts': '', 'new/orig.ts': '', 'app.ts': '',
    }));

    assert.strictEqual(idx.getImports('app.ts')[0].to, 'old/orig.ts');

    // config maps to ./new/* now — importer source untouched
    write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./new/*'] } } }));
    idx.updateFile('tsconfig.json', { content: JSON.stringify({ compilerOptions: { paths: { '@/*': ['./new/*'] } } }), isConfig: true });

    assert.strictEqual(idx.getImports('app.ts')[0].to, 'new/orig.ts');
    cleanup(dir);
});

// ── 5. Cross-language Node → Rust → protocol trace ────────────────────────
await test('node spawn → rust reads pipe → decodes EventEnvelope', async () => {
    const dir = await createProject({
        'src/daemon/rust-tui-host.mjs': [
            "import { spawn } from 'node:child_process';",
            "const child = spawn(binary, ['--stdio'], { stdio: ['inherit','inherit','inherit','pipe','pipe'] });",
        ].join('\n'),
        'rust/bahulam-tui/src/main.rs': [
            'use std::io::{BufRead, BufReader};',
            'let events = child_stdio_file(3)?;',
            'for line in BufReader::new(events).lines() {',
            '    if let Ok(event) = serde_json::from_str::<bahulam_tui::protocol::EventEnvelope>(&line) {}',
            '}',
        ].join('\n'),
        'rust/bahulam-tui/src/protocol.rs': '#[derive(serde::Deserialize)]\npub struct EventEnvelope {}\n',
    });
    const idx = new GraphIndexer(dir);
    await idx.buildGraph(absList(dir, {
        'src/daemon/rust-tui-host.mjs': '',
        'rust/bahulam-tui/src/main.rs': '',
        'rust/bahulam-tui/src/protocol.rs': '',
    }));

    const trace = idx.tracePath('src/daemon/rust-tui-host.mjs', 'rust/bahulam-tui/src/protocol.rs');
    assert.ok(trace.length >= 2, `expected spawns→decodes chain, got ${JSON.stringify(trace.map(e => e.kind))}`);
    assert.strictEqual(trace[0].kind, 'spawns', 'host spawns the rust binary');
    assert.ok(trace.some(e => e.kind === 'decodes'), 'has decodes edge');

    const importers = idx.getImporters('rust/bahulam-tui/src/main.rs');
    assert.ok(importers.some(e => e.kind === 'spawns'), 'main.rs is spawned by the host');
    // Reverse direction: main.rs reads the pipe Node opened and decodes envelopes.
    const mainImports = idx.getImports('rust/bahulam-tui/src/main.rs');
    assert.ok(mainImports.some(e => e.kind === 'reads_pipe' && e.to === 'src/daemon/rust-tui-host.mjs'), 'main.rs reads the Node pipe');
    assert.ok(mainImports.some(e => e.kind === 'decodes' && e.to === 'rust/bahulam-tui/src/protocol.rs'), 'main.rs decodes EventEnvelope');
    cleanup(dir);
});

// ── 6. Python relative import + SQL table references ──────────────────────
await test('python relative import resolves; sql table-refs are captured', async () => {
    const dir = await createProject({
        'pkg/__init__.py': 'from . import utils\n',
        'pkg/utils.py': 'def helper(): pass\n',
        'queries.sql': 'SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id;\n-- REFERENCES legacy.customers (id)\n',
    });
    const idx = new GraphIndexer(dir);
    await idx.buildGraph(absList(dir, {
        'pkg/__init__.py': '', 'pkg/utils.py': '', 'queries.sql': '',
    }));

    assert.strictEqual(idx.getImports('pkg/__init__.py')[0].to, 'pkg/utils.py');

    const sqlImports = idx.getImports('queries.sql');
    const tables = sqlImports.map(e => e.to).sort();
    assert.ok(tables.includes('users'), `users in ${tables}`);
    assert.ok(tables.includes('orders'), `orders in ${tables}`);
    assert.ok(tables.some(t => t === 'legacy.customers'), `REFERENCES captured in ${tables}`);
    cleanup(dir);
});

// ── Baseline: persistence + non-code files ────────────────────────────────
await test('graph persists and reloads', async () => {
    const dir = await createProject({
        'a.js': "import './b';\n",
        'b.js': 'export const b = 1;\n',
        'notes.md': '# no edges\n',
    });
    const idx = new GraphIndexer(dir);
    await idx.buildGraph(absList(dir, { 'a.js': '', 'b.js': '', 'notes.md': '' }));
    const indexDir = path.join(dir, '.index');
    idx.persist(indexDir);

    const reloaded = GraphIndexer.load(indexDir, dir);
    assert.ok(reloaded, 'reloads');
    assert.strictEqual(reloaded.getImports('a.js').length, 1);
    assert.strictEqual(reloaded.getImports('notes.md').length, 0, 'markdown produces no edges');
    cleanup(dir);
});

await test('getImporters/getImports/resolvePath basics', async () => {
    const dir = await createProject({
        'a.js': "import { b } from './b';\n",
        'b.js': 'export const b = 1;\n',
    });
    const idx = new GraphIndexer(dir);
    await idx.buildGraph(absList(dir, { 'a.js': '', 'b.js': '' }));
    assert.strictEqual(idx.resolvePath('./b', 'a.js'), 'b.js');
    assert.deepStrictEqual(idx.getImporters('b.js').map(e => e.from), ['a.js']);
    assert.deepStrictEqual(idx.getImports('a.js').map(e => e.to), ['b.js']);
    cleanup(dir);
});

await test('retriever indexes large source references up to the byte limit and upgrades saved graphs', async () => {
    const tail = "\nimport { x } from './leaf.js';";
    const atLimit = '//' + 'a'.repeat(MAX_GRAPH_SOURCE_BYTES - tail.length - 2) + tail;
    const dir = await createProject({
        'app.js': "import { x } from './large.ts';",
        'large.ts': atLimit,
        'leaf.js': 'export const x = 1;',
        'query.sql': 'SELECT * FROM reports',
    });
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-cache-'));
    const open = () => {
        const retriever = new ContextRetriever(dir);
        retriever.indexDir = cache;
        return retriever;
    };
    try {
        let retriever = open();
        await retriever.buildIndex();
        const large = path.join(dir, 'large.ts');
        const importer = path.join(dir, 'app.js');
        const leaf = path.join(dir, 'leaf.js');
        assert.deepStrictEqual(retriever.tracePath(importer, leaf).map(edge => edge.to), ['large.ts', 'leaf.js']);
        assert.strictEqual(retriever.getImports(path.join(dir, 'query.sql'))[0].to, 'reports');
        assert.ok(![...retriever.chunkTexts.keys()].some(id => id.startsWith('large.ts')));
        fs.writeFileSync(large, atLimit + 'é');
        retriever.updateFile(large);
        assert.strictEqual(retriever.getImports(importer)[0].status, 'resolved');
        assert.deepStrictEqual(retriever.getImports(large), []);
        assert.strictEqual(retriever.graphIndexer.nodes.get('large.ts').referencesSkipped, 'size_limit');
        retriever = open();
        assert.ok(retriever.loadIndex());
        assert.strictEqual(retriever.graphIndexer.nodes.get('large.ts').referencesSkipped, 'size_limit');
        fs.writeFileSync(large, atLimit);
        retriever.updateFile(large);
        assert.strictEqual(retriever.tracePath(importer, leaf).length, 2);

        // Simulate the cached graph produced by the old 100 KB discovery rule.
        const bm25 = fs.readFileSync(path.join(cache, 'bm25.json'));
        fs.writeFileSync(path.join(cache, 'graph.json'), JSON.stringify({version: 1, nodes: {}, edges: []}));
        retriever = open();
        assert.ok(retriever.loadIndex());
        assert.strictEqual(retriever.tracePath(importer, leaf).length, 2);
        assert.ok(GraphIndexer.load(cache, dir).nodes.has('large.ts'));
        assert.deepStrictEqual(fs.readFileSync(path.join(cache, 'bm25.json')), bm25);
    } finally {
        cleanup(dir);
        cleanup(cache);
    }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);