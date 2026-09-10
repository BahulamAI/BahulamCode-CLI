/**
 * Tests for manifest-declared plugin state (`config.state`).
 *
 * Covers the three pieces of the feature:
 *   1. manifest.mjs  — normalizing tables / context_always / context_tools
 *   2. state.mjs     — creating (+ additively migrating) declared tables,
 *                      plus the summary() / readTable() read primitives
 *   3. state-tools.mjs — expanding context_tools into registry tool entries
 *
 * Cases that need real DDL are skipped when the native node:sqlite backend
 * isn't available (the JSON fallback can't run arbitrary SQL), so this file
 * stays green on a stock Node 18 contributor machine.
 *
 * Each case runs in a fresh temp $HOME so plugin state files never touch the
 * user's real ~/.bahulam/data. The module caches DB handles process-wide, so
 * _resetForTests() runs between cases.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makePluginState, _resetForTests } from '../src/plugins/state.mjs';
import { parsePluginManifest, validatePluginManifest } from '../src/plugins/manifest.mjs';
import { expandStateContextTools } from '../src/plugins/state-tools.mjs';
import { PluginRegistry } from '../src/plugins/registry.mjs';
let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-state-schema-'));
  const savedHome = process.env.HOME;
  process.env.HOME = tmp;
  _resetForTests();
  try {
    const result = await fn(tmp);
    if (result === 'skip') {
      console.log(`  \x1b[33m-\x1b[0m ${name} (skipped: no native sqlite)`);
      skipped++;
      return;
    }
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  } finally {
    _resetForTests();
    process.env.HOME = savedHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** True when the state module opened a real SQLite DB rather than the JSON shim. */
function hasSqlite(state) {
  return state.db?.constructor?.name !== 'JsonStateDb';
}

const MANIFEST_YAML = `
apiVersion: bahulam.plugin/1
kind: Plugin
metadata:
  name: exam-tutor
  version: 1.0.0
config:
  state:
    tables:
      - name: questions
        columns:
          - { name: id, type: INTEGER, primary: true, autoincrement: true }
          - { name: topic, type: TEXT, not_null: true }
          - { name: prompt, type: TEXT }
        indexes:
          - { columns: [topic] }
      - name: answers
        columns:
          - { name: id, type: INTEGER, primary: true, autoincrement: true }
          - { name: question_id, type: INTEGER, references: "questions(id)" }
          - { name: correct, type: BOOLEAN }
    context_always:
      - progress
      - { stream: session_log, limit: 3 }
    context_tools:
      - name: list_questions
        table: questions
        description: List exam questions, optionally by topic
        parameters:
          type: object
          properties:
            topic: { type: string }
        where: "topic = ?"
        params: [topic]
`;

console.log('\nplugin state — manifest normalization (config.state)');

await test('manifest parses declared tables, indexes, and column affinities', async () => {
  const manifest = parsePluginManifest(MANIFEST_YAML);
  assert.ok(manifest, 'manifest should parse');
  const state = manifest.config.state;

  assert.strictEqual(state.tables.length, 2, 'two tables declared');
  const [questions, answers] = state.tables;
  assert.strictEqual(questions.name, 'questions');

  const id = questions.columns.find(c => c.name === 'id');
  assert.strictEqual(id.type, 'INTEGER');
  assert.strictEqual(id.primary, true);
  assert.strictEqual(id.autoincrement, true);

  const topic = questions.columns.find(c => c.name === 'topic');
  assert.strictEqual(topic.not_null, true);

  // BOOL is accepted as an alias and collapses to INTEGER.
  const correct = answers.columns.find(c => c.name === 'correct');
  assert.strictEqual(correct.type, 'INTEGER');

  // References survive only in the strict `table(column)` shape.
  const qid = answers.columns.find(c => c.name === 'question_id');
  assert.strictEqual(qid.references, 'questions(id)');

  assert.deepStrictEqual(questions.indexes, [{ columns: ['topic'], unique: false }]);
});

await test('manifest normalizes both context_always forms', async () => {
  const state = parsePluginManifest(MANIFEST_YAML).config.state;
  assert.deepStrictEqual(state.context_always, [
    { kind: 'kv', key: 'progress' },
    { kind: 'records', stream: 'session_log', limit: 3 },
  ]);
});

await test('context_tools keep their where/params binding contract', async () => {
  const state = parsePluginManifest(MANIFEST_YAML).config.state;
  const tool = state.context_tools[0];
  assert.strictEqual(tool.name, 'list_questions');
  assert.strictEqual(tool.table, 'questions');
  assert.strictEqual(tool.where, 'topic = ?');
  assert.deepStrictEqual(tool.params, ['topic']);
  assert.strictEqual(tool.limit, 50, 'defaults to 50 rows');
  assert.strictEqual(tool.parameters.properties.topic.type, 'string');
});

await test('manifest rejects identifiers that could escape a quoted DDL string', async () => {
  const manifest = parsePluginManifest(`
apiVersion: bahulam.plugin/1
metadata: { name: evil }
config:
  state:
    tables:
      - name: "kv; DROP TABLE kv"
        columns: [{ name: id, type: INTEGER }]
      - name: safe_table
        columns:
          - { name: 'x"; DROP TABLE kv; --', type: TEXT }
          - { name: id, type: INTEGER }
`);
  const state = manifest.config.state;
  assert.strictEqual(state.tables.length, 1, 'only the safe table survives');
  assert.strictEqual(state.tables[0].name, 'safe_table');
  assert.deepStrictEqual(state.tables[0].columns.map(c => c.name), ['id']);
});

await test('context_tools referencing an undeclared table are dropped', async () => {
  const manifest = parsePluginManifest(`
apiVersion: bahulam.plugin/1
metadata: { name: p }
config:
  state:
    tables:
      - name: known
        columns: [{ name: id, type: INTEGER }]
    context_tools:
      - { name: ok_tool, table: known }
      - { name: bad_tool, table: not_declared }
`);
  assert.deepStrictEqual(
    manifest.config.state.context_tools.map(t => t.name),
    ['ok_tool'],
  );
  assert.strictEqual(validatePluginManifest(manifest).valid, true);
});

await test('validate surfaces an undeclared table on a hand-edited manifest', async () => {
  const manifest = parsePluginManifest(MANIFEST_YAML);
  // Simulate a manifest that was normalized before the table was removed —
  // validate() is the backstop the author sees.
  manifest.config.state.tables = [];
  const { valid, errors } = validatePluginManifest(manifest);
  assert.strictEqual(valid, false);
  assert.ok(errors.some(e => /undeclared table/.test(e)), `expected undeclared-table error, got ${JSON.stringify(errors)}`);
});

await test('a plugin with no config.state still normalizes to empty arrays', async () => {
  const manifest = parsePluginManifest(`
apiVersion: bahulam.plugin/1
metadata: { name: plain }
config:
  tools:
    - { name: t, tool: ./tools/t.mjs }
`);
  assert.deepStrictEqual(manifest.config.state, {
    tables: [],
    context_always: [],
    context_tools: [],
  });
});

console.log('\nplugin state — declared tables (DDL + migration)');

// The DDL shape both the create and migration cases exercise.
const TABLES_V1 = [{
  name: 'questions',
  columns: [
    { name: 'id', type: 'INTEGER', primary: true, autoincrement: true, not_null: false, default: null, references: null },
    { name: 'topic', type: 'TEXT', primary: false, autoincrement: false, not_null: true, default: null, references: null },
  ],
  indexes: [{ columns: ['topic'], unique: false }],
}];

await test('declared tables are created when the state DB opens', async () => {
  const s = makePluginState('exam-tutor', { tables: TABLES_V1 });
  if (!hasSqlite(s)) return 'skip';

  const cols = s.query('PRAGMA table_info(questions)').map(r => r.name);
  assert.deepStrictEqual(cols, ['id', 'topic']);

  // Both the built-in tables and the declared one coexist.
  s.append('session_log', { event: 'started' });
  assert.strictEqual(s.list('session_log').length, 1);

  const indexes = s.query('PRAGMA index_list(questions)').map(r => r.name);
  assert.ok(indexes.length >= 1, 'declared index should exist');
});

await test('reopening applies schema idempotently and adds new columns without data loss', async () => {
  const s1 = makePluginState('exam-tutor', { tables: TABLES_V1 });
  if (!hasSqlite(s1)) return 'skip';

  s1.query('INSERT INTO questions(topic) VALUES(?)', ['algebra']);

  // v2 adds a column. The old row must survive the migration.
  const tablesV2 = [{
    ...TABLES_V1[0],
    columns: [
      ...TABLES_V1[0].columns,
      { name: 'prompt', type: 'TEXT', primary: false, autoincrement: false, not_null: false, default: null, references: null },
    ],
  }];
  const s2 = makePluginState('exam-tutor', { tables: tablesV2 });

  assert.deepStrictEqual(
    s2.query('PRAGMA table_info(questions)').map(r => r.name),
    ['id', 'topic', 'prompt'],
  );
  const rows = s2.query('SELECT topic FROM questions');
  assert.strictEqual(rows.length, 1, 'existing row survives the migration');
  assert.strictEqual(rows[0].topic, 'algebra');
});

await test('reopening with an unchanged declaration is a no-op (no duplicate columns)', async () => {
  const s1 = makePluginState('exam-tutor', { tables: TABLES_V1 });
  if (!hasSqlite(s1)) return 'skip';
  const s2 = makePluginState('exam-tutor', { tables: TABLES_V1 });
  assert.deepStrictEqual(
    s2.query('PRAGMA table_info(questions)').map(r => r.name),
    ['id', 'topic'],
  );
});

console.log('\nplugin state — summary() and readTable()');

await test('summary returns only the declared kv keys and streams', async () => {
  const s = makePluginState('exam-tutor', { tables: TABLES_V1 });
  s.set('progress', { lesson: 3, score: '7/10' });
  s.set('internal_cursor', 'not-declared');
  s.append('session_log', { event: 'oldest' });
  s.append('session_log', { event: 'newest' });

  const summary = s.summary([
    { kind: 'kv', key: 'progress' },
    { kind: 'records', stream: 'session_log', limit: 1 },
  ]);

  assert.deepStrictEqual(summary.kv, { progress: { lesson: 3, score: '7/10' } });
  assert.ok(!('internal_cursor' in summary.kv), 'undeclared keys stay out of context');
  assert.strictEqual(summary.streams.session_log.length, 1, 'limit is honored');
  assert.strictEqual(summary.streams.session_log[0].payload.event, 'newest');
});

await test('summary tolerates a missing key without blanking the rest', async () => {
  const s = makePluginState('exam-tutor');
  s.set('progress', 1);
  const summary = s.summary([{ kind: 'kv', key: 'never_set' }, { kind: 'kv', key: 'progress' }]);
  assert.strictEqual(summary.kv.never_set, null);
  assert.strictEqual(summary.kv.progress, 1);
});

await test('summary on an empty declaration is empty', async () => {
  const s = makePluginState('exam-tutor');
  assert.deepStrictEqual(s.summary(), { kv: {}, streams: {} });
});

await test('readTable binds params, honors limit, and only reaches declared tables', async () => {
  const s = makePluginState('exam-tutor', { tables: TABLES_V1 });
  if (!hasSqlite(s)) return 'skip';

  s.query('INSERT INTO questions(topic) VALUES(?)', ['algebra']);
  s.query('INSERT INTO questions(topic) VALUES(?)', ['geometry']);
  s.query('INSERT INTO questions(topic) VALUES(?)', ['algebra']);

  const filtered = s.readTable('questions', { where: 'topic = ?', params: ['algebra'], limit: 5 });
  assert.strictEqual(filtered.length, 2);

  const capped = s.readTable('questions', { limit: 1 });
  assert.strictEqual(capped.length, 1);

  // The built-in tables are not declared, so they are unreachable here —
  // an author-supplied `where` cannot widen this into arbitrary access.
  assert.throws(() => s.readTable('kv'), /unknown declared state table/);
  assert.throws(() => s.readTable('records'), /unknown declared state table/);
});

await test('readTable refuses a plugin that declared no tables', async () => {
  const s = makePluginState('plain-plugin');
  if (!hasSqlite(s)) return 'skip';
  assert.throws(() => s.readTable('questions'), /unknown declared state table/);
});

console.log('\nplugin state — context tool expansion');

await test('expandStateContextTools emits importable-shaped entries with no module path', async () => {
  const manifest = parsePluginManifest(MANIFEST_YAML);
  const tools = expandStateContextTools('exam-tutor', '/tmp/exam-tutor', manifest.config.state);

  assert.strictEqual(tools.length, 1);
  const tool = tools[0];
  assert.strictEqual(tool.name, 'list_questions');
  assert.strictEqual(tool.tool, null, 'synthesized tools have no handler file');
  assert.strictEqual(tool._plugin_name, 'exam-tutor');
  assert.strictEqual(tool._plugin_dir, '/tmp/exam-tutor');
  assert.strictEqual(tool.input_schema.properties.topic.type, 'string');
  assert.deepStrictEqual(tool._state_tool, {
    plugin: 'exam-tutor',
    table: 'questions',
    where: 'topic = ?',
    params: ['topic'],
    limit: 50,
  });
});

await test('expansion sanitizes tool names and skips undeclared tables', async () => {
  const tools = expandStateContextTools('p', '/tmp/p', {
    tables: [{ name: 'known', columns: [] }],
    context_tools: [
      { name: 'weird-name!!', table: 'known' },
      { name: 'ghost', table: 'not_declared' },
    ],
  });
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, 'weird_name__');
});

await test('a plugin with no declared state expands to nothing', async () => {
  assert.deepStrictEqual(expandStateContextTools('p', '/tmp/p', undefined), []);
  assert.deepStrictEqual(expandStateContextTools('p', '/tmp/p', { tables: [], context_tools: [] }), []);
  assert.deepStrictEqual(expandStateContextTools('', '/tmp/p', { tables: [{ name: 't' }] }), []);
});

console.log('\nplugin state — registry integration');

await test('a scanned plugin surfaces its generated state tool through listTools()', async (tmp) => {
  const root = path.join(tmp, 'plugins');
  const pluginDir = path.join(root, 'exam-tutor');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.yaml'), MANIFEST_YAML, 'utf-8');

  const registry = new PluginRegistry({ pluginDirs: [root] }).scan();
  assert.strictEqual(
    registry.count(),
    1,
    `expected one plugin on disk, errors: ${JSON.stringify(registry.errors)}`,
  );

  // listTools() is the surface `stream-client._getPluginToolMap()` and
  // `listPluginToolSchemas()` read, so this is what makes the generated
  // tool reachable by the model rather than just registered internally.
  const tools = registry.listTools();
  const generated = tools.find(t => t.name === 'list_questions');
  assert.ok(generated, `expected list_questions among ${JSON.stringify(tools.map(t => t.name))}`);
  assert.strictEqual(generated.tool, null, 'synthesized — no handler module');
  assert.strictEqual(generated._plugin_name, 'exam-tutor');
  assert.strictEqual(generated._state_tool.table, 'questions');
  assert.deepStrictEqual(generated._state_tool.params, ['topic']);
  assert.strictEqual(generated.input_schema.properties.topic.type, 'string');
});

await test('a plugin without config.state adds no generated tools', async (tmp) => {
  const root = path.join(tmp, 'plugins');
  const pluginDir = path.join(root, 'plain');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.yaml'), `
apiVersion: bahulam.plugin/1
metadata: { name: plain }
config:
  tools:
    - { name: greet, tool: ./tools/greet.mjs }
`, 'utf-8');

  const registry = new PluginRegistry({ pluginDirs: [root] }).scan();
  assert.deepStrictEqual(registry.listTools().map(t => t.name), ['greet']);
});

console.log(`\n${passed}/${passed + failed} passed${skipped ? `, ${skipped} skipped` : ''}`);
if (failed) process.exit(1);
