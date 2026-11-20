/**
 * Tests for the code-graph viewer adapter (src/graph/adapter.mjs).
 *
 * Mirrors test-graph-index.mjs style: temp dirs, fake BAHULAM_HOME, a tiny
 * test runner with passed/failed counters.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listIndexedGraphs, loadGraphJson, adaptGraph } from '../src/graph/adapter.mjs';
import { projectHash } from '../src/core/paths.mjs';

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
  else { failed++; console.error(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
}

function makeHome(projectRoot, graph, resource) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-graph-'));
  const home = path.join(tmp, '.bahulam');
  const hash = projectHash(projectRoot);
  const project = path.join(home, 'projects', hash);
  const indexDir = path.join(project, 'index');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, 'graph.json'), JSON.stringify(graph));
  if (resource) fs.writeFileSync(path.join(indexDir, 'project-resource.json'), JSON.stringify(resource));
  return { home, hash, root: projectRoot };
}

const sampleGraph = {
  version: 2,
  sourceStamps: { 'src/a.js': '1:2:3' },
  nodes: {
    'src/a.js': { kind: 'File', language: 'js' },
    'src/b.ts': { kind: 'File', language: 'ts' },
    'lib/c.py': { kind: 'File', language: 'python' },
  },
  edges: [
    { from: 'src/a.js', to: 'src/b.ts', spec: './b', kind: 'imports', line: 1, status: 'resolved', candidates: [] },
    { from: 'src/a.js', to: './missing', spec: './missing', kind: 'imports', line: 2, status: 'unresolved', candidates: ['src/missing.ts', 'src/missing.tsx'] },
    { from: 'lib/c.py', to: 'pandas', spec: 'pandas', kind: 'imports', line: 3, status: 'unresolved', candidates: [] },
  ],
};

const meta = { hash: '0123456789abcdef', root: '/tmp/repo', name: 'repo-name', nodeCount: 3, edgeCount: 3, mtime: 123 };

// ── adaptGraph unit tests ──
console.log('adaptGraph:');

let view = adaptGraph(null, meta);
eq(view.nodes.length, 0, 'null graph → empty payload');
eq(view.repo.name, 'repo-name', 'null graph preserves repo meta');

view = adaptGraph(sampleGraph, meta);
eq(view.version, 2, 'version passthrough');
eq(view.nodes.filter(n => !n.ghost).length, 3, 'three real file nodes');
eq(view.nodeTypes, ['js', 'python', 'ts', 'unresolved'], 'node types sorted (languages + ghost type)');
eq(view.predicates, ['imports'], 'predicates (edge kinds)');
eq(view.edgeStatuses, ['resolved', 'unresolved'], 'edge statuses');

const a = view.nodes.find(n => n.id === 'src/a.js');
eq(a.label, 'a.js', 'label = basename');
eq(a.type, 'js', 'type = language');
eq(a.status, 'has-unresolved', 'derived status: unresolved outgoing');

const b = view.nodes.find(n => n.id === 'src/b.ts');
eq(b.status, 'connected', 'derived status: resolved edge');

const py = view.nodes.find(n => n.id === 'lib/c.py');
eq(py.status, 'has-unresolved', 'python unresolved import → has-unresolved');

const ghosts = view.nodes.filter(n => n.ghost);
eq(ghosts.length, 2, 'two ghost nodes for unresolved specs (./missing, pandas)');
eq(ghosts[0].id, 'spec:./missing', 'ghost id namespaced');

const edgeToGhost = view.edges.find(e => e.target.startsWith('spec:'));
ok(edgeToGhost && edgeToGhost.rawTarget === './missing', 'edge to ghost keeps rawTarget');

// ── listIndexedGraphs + loadGraphJson with fake home ──
console.log('listIndexedGraphs / loadGraphJson:');

const { home, hash, root } = makeHome('/tmp/repo', sampleGraph, { root: '/tmp/repo', name: 'repo-name' });
let repos = listIndexedGraphs({ home });
eq(repos.length, 1, 'one indexed repo found');
eq(repos[0].hash, hash, 'hash preserved');
eq(repos[0].name, 'repo-name', 'name from project-resource.json');
eq(repos[0].root, '/tmp/repo', 'root from project-resource.json');
eq(repos[0].nodeCount, 3, 'node count');
eq(repos[0].edgeCount, 3, 'edge count');

const prevHome = process.env.BAHULAM_HOME;
process.env.BAHULAM_HOME = home;
const loaded = loadGraphJson(repos[0].root);
eq(loaded.version, 2, 'loadGraphJson parses graph.json');
process.env.BAHULAM_HOME = prevHome;

const emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-graph-empty-'));
const empty = { home: path.join(emptyTmp, '.bahulam') };
fs.mkdirSync(path.join(empty.home, 'projects'), { recursive: true });
repos = listIndexedGraphs({ home: empty.home });
eq(repos.length, 0, 'no graphs in a fresh home');
fs.rmSync(emptyTmp, { recursive: true, force: true });

fs.rmSync(path.dirname(home), { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);