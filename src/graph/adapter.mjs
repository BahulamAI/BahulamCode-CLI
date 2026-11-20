/**
 * Code-graph adapter — the single place that maps the persisted repo graph
 * (graph-indexer.mjs output) onto the browser viewer's normalized payload.
 *
 * Pure + zero-dep. Unit-testable via test/test-graph-viewer.mjs.
 *
 * Data path:
 *   ContextRetriever.buildIndex() → GraphIndexer → ~/.bahulam/projects/{hash}/index/graph.json
 *   { version:2, sourceStamps, nodes: { relPath: {kind:'File', language} }, edges:[{from,to,spec,kind,line,status,candidates}] }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { indexDir, bahulamHome } from '../core/paths.mjs';

/**
 * Scan every indexed repo: ~/.bahulam/projects/<hash>/index/graph.json
 * plus the sibling project-resource.json for the authoritative root/name.
 *
 * @param {{home?: string}} [opts]
 * @returns {Array<{hash:string, root:string, name:string, nodeCount:number, edgeCount:number, mtime:number|null}>}
 */
export function listIndexedGraphs({ home } = {}) {
  const root = home || bahulamHome();
  const projectsRoot = path.join(root, 'projects');
  let hashes = [];
  try {
    hashes = fs.readdirSync(projectsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  const repos = [];
  for (const hash of hashes) {
    const graphPath = path.join(projectsRoot, hash, 'index', 'graph.json');
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
    } catch {
      continue; // no index yet — user will see the friendly hint instead
    }
    const resourcePath = path.join(projectsRoot, hash, 'index', 'project-resource.json');
    let rootDir = hash;
    let name = hash;
    try {
      const res = JSON.parse(fs.readFileSync(resourcePath, 'utf-8'));
      if (res.root) rootDir = res.root;
      if (res.name) name = res.name;
    } catch { /* fall back to hash */ }

    let mtime = null;
    try { mtime = fs.statSync(graphPath).mtimeMs; } catch { /* ignore */ }

    const nodeCount = raw.nodes ? Object.keys(raw.nodes).length : 0;
    const edgeCount = Array.isArray(raw.edges) ? raw.edges.length : 0;
    repos.push({ hash, root: rootDir, name, nodeCount, edgeCount, mtime });
  }
  repos.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return repos;
}

/**
 * Load the raw graph.json for a project directory.
 * @param {string} projectDir
 * @returns {object|null} raw graph or null when no index exists yet
 */
export function loadGraphJson(projectDir) {
  const graphPath = path.join(indexDir(projectDir), 'graph.json');
  try {
    return JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Pure mapping: raw graph.json → viewer payload.
 *
 * - node id = relPath; label = basename; type = language
 * - unresolved edges (to === raw spec, not a node key) get synthetic ghost
 *   nodes so filters/edges still work and "broken imports" stay visible
 * - derived node status: has-unresolved | connected | isolated
 *
 * @param {object|null} raw — the raw graph.json (or null when not indexed)
 * @param {object} meta — { hash, root, name, mtime } from listIndexedGraphs
 * @returns {object} viewer payload described in src/graph/viewer.mjs
 */
export function adaptGraph(raw, meta = {}) {
  const empty = {
    repos: [],
    repo: {
      hash: meta.hash || '?',
      root: meta.root || '',
      name: meta.name || meta.hash || '?',
      nodeCount: 0,
      edgeCount: 0,
      mtime: meta.mtime ?? null,
    },
    version: raw?.version || 0,
    nodes: [],
    edges: [],
    nodeTypes: [],
    predicates: [],
    edgeStatuses: ['resolved', 'unresolved'],
  };
  if (!raw || !raw.nodes) return empty;

  const rawNodes = raw.nodes && typeof raw.nodes === 'object' ? raw.nodes : {};
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  const knownIds = new Set(Object.keys(rawNodes));

  // ── Nodes (files) + derived status ──
  const nodeById = new Map();
  const outgoingStatus = new Map(); // id -> has unresolved outgoing?
  const touched = new Set();        // id -> has any resolved edge
  for (const edge of rawEdges) {
    if (edge.status === 'unresolved') outgoingStatus.set(edge.from, true);
    else { touched.add(edge.from); touched.add(edge.to); }
  }
  for (const [rel, meta2] of Object.entries(rawNodes)) {
    const lang = meta2?.language || 'file';
    let status = 'isolated';
    if (outgoingStatus.has(rel)) status = 'has-unresolved';
    else if (touched.has(rel)) status = 'connected';
    nodeById.set(rel, {
      id: rel,
      label: path.posix.basename(rel) || rel,
      fullPath: rel,
      type: lang,
      status,
      ghost: false,
    });
  }

  // ── Ghost nodes for unresolved targets that aren't files ──
  const ghostById = new Map();
  const addGhost = (spec) => {
    const id = 'spec:' + spec;
    if (!ghostById.has(id)) {
      ghostById.set(id, {
        id,
        label: spec,
        fullPath: spec,
        type: 'unresolved',
        status: 'has-unresolved',
        ghost: true,
      });
    }
    return id;
  };

  // ── Edges ──
  const edges = rawEdges.map((edge, idx) => {
    let target = edge.to;
    if (!knownIds.has(edge.to)) target = addGhost(edge.to);
    return {
      id: edge.id != null ? String(edge.id) : `e${idx}`,
      source: edge.from,
      target,
      rawTarget: edge.to,
      spec: edge.spec || '',
      kind: edge.kind || 'imports',
      line: edge.line || 0,
      status: edge.status || 'resolved',
      candidates: Array.isArray(edge.candidates) ? edge.candidates : [],
    };
  });

  const nodes = [...nodeById.values(), ...ghostById.values()];
  const nodeTypes = [...new Set(nodes.map(n => n.type))].sort();
  const predicates = [...new Set(edges.map(e => e.kind))].sort();

  return {
    repos: [],
    repo: {
      hash: meta.hash || '?',
      root: meta.root || '',
      name: meta.name || meta.hash || '?',
      nodeCount: nodes.length,
      edgeCount: edges.length,
      mtime: meta.mtime ?? null,
    },
    version: raw.version || 2,
    nodes,
    edges,
    nodeTypes,
    predicates,
    edgeStatuses: ['resolved', 'unresolved'],
  };
}