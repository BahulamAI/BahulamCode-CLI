/**
 * Cross-language reference graph (additive to BM25).
 *
 * One repository graph with a resolver per language. Persisted as graph.json
 * beside bm25.json/chunks.json/symbols.json under
 * ~/.bahulam/projects/{hash}/index/. Skills, agents and plugins are OUT of
 * scope for v1: this graph only answers checkout-bound questions
 * ("which files import this module?").
 *
 * Every edge carries source-file:line evidence. Unresolved references stay in
 * the graph with status 'unresolved' so BM25 can still find candidates without
 * pretending the graph knows the answer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const LANG_BY_EXT = {
  '.js': 'js', '.mjs': 'js', '.jsx': 'js',
  '.ts': 'ts', '.tsx': 'ts',
  '.py': 'python',
  '.rs': 'rust',
  '.sql': 'sql',
};

const GRAPH_VERSION = 2;
export const MAX_GRAPH_SOURCE_BYTES = 2 * 1024 * 1024;

export function isGraphSource(filePath) {
  return Boolean(LANG_BY_EXT[path.extname(filePath).toLowerCase()]);
}

// ── Known cross-language handoff pathways (Bahulam's own architecture) ─────
const NODE_RUST_HOST = 'src/daemon/rust-tui-host.mjs';
const RUST_TUI_MAIN = 'rust/bahulam-tui/src/main.rs';
const RUST_TUI_PROTOCOL = 'rust/bahulam-tui/src/protocol.rs';

function normalizeRel(p) {
  return String(p || '').split(path.sep).join('/').replace(/^\.\//, '');
}

export class GraphIndexer {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.nodes = new Map(); // relPath -> { kind: 'File', language }
    this.edges = []; // { from, to, kind, line, status, candidates?, ambiguity? }
    this.reverseIndex = new Map(); // target -> edge indexes
    this._configCache = new Map(); // config relPath -> parsed JSON
  }

  // ── Build ────────────────────────────────────────────────────────────────

  /** @param {string[]} files absolute paths */
  async buildGraph(files) {
    return this.indexFiles(files);
  }

  // Also used by synchronous index loading to upgrade an older saved graph.
  indexFiles(files) {
    this.nodes.clear();
    this.edges = [];
    this.reverseIndex = new Map();
    this._configCache.clear();

    for (const abs of files) {
      const rel = normalizeRel(path.relative(this.projectDir, abs));
      const ext = path.extname(abs).toLowerCase();
      const language = LANG_BY_EXT[ext];
      if (!language) continue;
      this.nodes.set(rel, { kind: 'File', language });
    }

    for (const rel of this.nodes.keys()) this._extractFile(rel);
    this._rebuildReverseIndex();
    return { nodeCount: this.nodes.size, edgeCount: this.edges.length };
  }

  // ── Incremental update ───────────────────────────────────────────────────

  /**
   * Recompute edges cheaply after one file change.
   * @param {string} relPath project-relative path (posix separators ok)
   * @param {{content: string|null, isConfig?: boolean, fromDisk?: boolean}} opts
   *   content null => file deleted; isConfig => alias/mapping file changed
   */
  updateFile(relPath, { content = null, isConfig = false, fromDisk = false } = {}) {
    const rel = normalizeRel(relPath);
    const wasKnown = this.nodes.has(rel);
    const before = this.edges.length;

    if (isConfig) {
      this._configCache.delete(rel);
      this._reExtractSubtree(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));
      this._rebuildReverseIndex();
      return before !== this.edges.length;
    }

    if (!isGraphSource(rel)) return false;
    let exists = content !== null;
    if (fromDisk) {
      try { exists = fs.lstatSync(path.join(this.projectDir, rel)).isFile(); }
      catch { exists = false; }
    }
    const affected = new Set([rel]);
    for (const edge of this.edges) {
      if (edge.to === rel || (exists && !wasKnown && edge.status === 'unresolved')) {
        affected.add(edge.from);
      }
    }
    if (exists) this.nodes.set(rel, { kind: 'File', language: LANG_BY_EXT[path.extname(rel).toLowerCase()] });
    else this.nodes.delete(rel);

    this.edges = this.edges.filter(edge => !affected.has(edge.from));
    for (const file of affected) {
      if (this.nodes.has(file)) this._extractFile(file, file === rel && !fromDisk ? content : undefined);
    }
    this._rebuildReverseIndex();
    return true;
  }

  _reExtractSubtree(prefix) {
    const affected = new Set([...this.nodes.keys()].filter(rel => !prefix || rel.startsWith(prefix + '/')));
    this.edges = this.edges.filter(edge => !affected.has(edge.from));
    for (const rel of affected) this._extractFile(rel);
  }

  _extractFile(rel, content) {
    const node = this.nodes.get(rel);
    delete node.referencesSkipped;
    try {
      const abs = path.join(this.projectDir, rel);
      const size = content === undefined ? fs.statSync(abs).size : Buffer.byteLength(content);
      if (size > MAX_GRAPH_SOURCE_BYTES) {
        node.referencesSkipped = 'size_limit';
        return;
      }
      content ??= fs.readFileSync(abs, 'utf8');
    } catch {
      node.referencesSkipped = 'unreadable';
      return;
    }
    // All pre-existing outgoing edges for this file have been removed.
    const seen = new Set();
    for (const edge of this._extractEdges(rel, content, path.extname(rel).toLowerCase())) {
      const key = JSON.stringify([edge.to, edge.kind, edge.line]);
      if (!seen.has(key)) this.edges.push(edge);
      seen.add(key);
    }
  }

  _extractEdges(rel, content, ext) {
    const edges = [];
    const lang = LANG_BY_EXT[ext];
    if (lang === 'js' || lang === 'ts') edges.push(...this._extractJsTs(rel, content));
    else if (lang === 'python') edges.push(...this._extractPython(rel, content));
    else if (lang === 'rust') edges.push(...this._extractRust(rel, content));
    else if (lang === 'sql') edges.push(...this._extractSql(rel, content));
    edges.push(...this._detectHandoffs(rel, content));
    return edges;
  }

  _extractJsTs(rel, content) {
    const edges = [];
    const dir = path.posix.dirname(rel);
    // import x from 's' | import 's' | import type {..} from 's' | export .. from 's'
    const fromRe = /(?:^|\n)\s*(?:import|export)([\s\S]*?)from\s*['"]([^'"]+)['"]/g;
    const sideEffectRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
    const dynamicRe = /(?:^|\n)\s*import\(\s*['"]([^'"]+)['"]\s*\)/g;
    const requireRe = /(?:^|\n)\s*(?:const|let|var)?[^;\n]*?require\(\s*['"]([^'"]+)['"]\s*\)/g;

    const pushLine = (spec, lineIdx, prefix = '') => {
      const kind = /type\b/.test(prefix) ? 'type-import' : 'imports';
      this._pushResolved(edges, rel, spec, lineIdx, dir, kind);
    };

    let m;
    fromRe.lastIndex = 0;
    while ((m = fromRe.exec(content))) {
      const lineIdx = 1 + content.slice(0, m.index).split('\n').length - 1;
      pushLine(m[2], lineIdx, m[1]);
    }
    sideEffectRe.lastIndex = 0;
    while ((m = sideEffectRe.exec(content))) {
      const lineIdx = 1 + content.slice(0, m.index).split('\n').length - 1;
      this._pushResolved(edges, rel, m[1], lineIdx, dir, 'imports');
    }
    dynamicRe.lastIndex = 0;
    while ((m = dynamicRe.exec(content))) {
      const lineIdx = 1 + content.slice(0, m.index).split('\n').length - 1;
      this._pushResolved(edges, rel, m[1], lineIdx, dir, 'imports');
    }
    requireRe.lastIndex = 0;
    while ((m = requireRe.exec(content))) {
      const lineIdx = 1 + content.slice(0, m.index).split('\n').length - 1;
      this._pushResolved(edges, rel, m[1], lineIdx, dir, 'imports');
    }
    return edges;
  }

  _extractPython(rel, content) {
    const edges = [];
    const dir = path.posix.dirname(rel);
    const re = /(?:^|\n)\s*(?:from\s+(\.+)([\w.]*)\s+import\s+([\w.*]+(?:\s*,\s*[\w.*]+)*)|from\s+([\w.]+)\s+import\s+([\w.*]+(?:\s*,\s*[\w.*]+)*)|import\s+([\w.]+))/g;
    let m;
    while ((m = re.exec(content))) {
      const lineIdx = 1 + content.slice(0, m.index).split('\n').length - 1;
      const relDots = m[1] || '';
      let relMod = m[2] || '';
      const fromImports = m[3] || '';
      const absMod = m[4] || m[6] || '';
      if (relDots && !relMod && fromImports) {
        // 'from . import utils' → the first import name is the submodule.
        relMod = fromImports.trim().split(/[\s,]+/)[0] || '';
      }
      let spec;
      if (relDots) spec = relDots + (relMod ? '.' + relMod : '');
      else spec = absMod;

      if (relDots) {
        const base = this._pythonRelativeBase(dir, relDots.length - 1);
        const target = this._pythonResolveModule(base, relMod);
        this._pushFileTarget(edges, rel, target, lineIdx, 'imports', spec);
      } else {
        const hits = this._pythonResolveAbsolute(spec);
        if (hits.length === 1) this._pushFileTarget(edges, rel, hits[0], lineIdx, 'imports', spec);
        else this._pushUnresolved(edges, rel, spec, lineIdx, 'imports', hits);
      }
    }
    return edges;
  }

  _extractRust(rel, content) {
    const edges = [];
    const dir = path.posix.dirname(rel);
    const crateRoot = this._rustCrateRoot(rel);

    // mod foo;  →  foo.rs | foo/mod.rs
    const modRe = /(?:^|\n)\s*(?:pub\s+)?mod\s+(\w+)\s*;/g;
    let m;
    while ((m = modRe.exec(content))) {
      const lineIdx = 1 + content.slice(0, m.index).split('\n').length - 1;
      for (const candidate of [`${dir}/${m[1]}.rs`, `${dir}/${m[1]}/mod.rs`]) {
        if (this._exists(candidate)) {
          this._pushFileTarget(edges, rel, candidate, lineIdx, 'imports', `mod ${m[1]}`);
          break;
        }
      }
    }

    // use path::Item;  |  pub use path as Alias;  (re-export)
    const useRe = /(?:^|\n)\s*(pub\s+)?use\s+([^;]+);/g;
    while ((m = useRe.exec(content))) {
      const lineIdx = 1 + content.slice(0, m.index).split('\n').length - 1;
      const isPub = Boolean(m[1]);
      const usePath = m[2].trim().split(/\s+as\s+/)[0].trim();
      const target = this._rustResolveUse(usePath, dir, crateRoot, rel);
      if (target) {
        this._pushFileTarget(edges, rel, target, lineIdx, isPub ? 're-exports' : 'imports', usePath);
      } else {
        this._pushUnresolved(edges, rel, usePath, lineIdx, isPub ? 're-exports' : 'imports', []);
      }
    }
    return edges;
  }

  _extractSql(rel, content) {
    const edges = [];
    const re = /\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES)\s+([A-Za-z_][\w.]*)/g;
    let m;
    while ((m = re.exec(content))) {
      const lineIdx = 1 + content.slice(0, m.index).split('\n').length - 1;
      edges.push({
        from: rel, to: m[1], kind: 'table-ref', line: lineIdx,
        status: 'unresolved', candidates: [],
      });
    }
    return edges;
  }

  // ── Handoff edges (Node ⇄ Rust JSONL bridge) ─────────────────────────────

  _detectHandoffs(rel, content) {
    const edges = [];
    if (rel === NODE_RUST_HOST && /spawn\([^)]*['"]--stdio['"]/.test(content)) {
      const lineIdx = this._lineOf(content, /spawn\(/);
      this._pushFileTarget(edges, rel, RUST_TUI_MAIN, lineIdx, 'spawns', 'spawn(binary, --stdio)');
    }
    if (rel === RUST_TUI_MAIN) {
      const readIdx = this._lineOf(content, /child_stdio_file\(3\)/);
      if (readIdx > 0) {
        this._pushFileTarget(edges, rel, NODE_RUST_HOST, readIdx, 'reads_pipe', 'child_stdio_file(3)');
      }
      const decodeIdx = this._lineOf(content, /protocol::EventEnvelope/);
      if (decodeIdx > 0) {
        this._pushFileTarget(edges, rel, RUST_TUI_PROTOCOL, decodeIdx, 'decodes', 'EventEnvelope');
      }
    }
    return edges;
  }

  // ── Resolution helpers ───────────────────────────────────────────────────

  _pushResolved(edges, fromRel, spec, line, dir, kind) {
    const target = this._resolveJsTs(spec, dir, fromRel);
    if (target) this._pushFileTarget(edges, fromRel, target, line, kind, spec);
    else this._pushUnresolved(edges, fromRel, spec, line, kind, this._jsTsCandidates(spec, dir));
  }

  _pushFileTarget(edges, from, targetRel, line, kind, spec) {
    edges.push({
      from, to: targetRel, spec, kind, line,
      status: this.nodes.has(targetRel) ? 'resolved' : 'unresolved',
      candidates: [],
    });
  }

  _pushUnresolved(edges, from, spec, line, kind, candidates = []) {
    edges.push({ from, to: spec, spec, kind, line, status: 'unresolved', candidates });
  }

  _resolveJsTs(spec, importerDir, importerRel) {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return this._resolveRelative(path.posix.join(importerDir, spec));
    }
    if (spec.startsWith('@/') || spec.startsWith('@')) {
      const mapped = this._tsconfigMapping(spec, importerRel);
      if (mapped !== null) {
        // mapped.key may be '@/*' and mapped.target './src/*'. The remainder is
        // the spec after the mapping's own key prefix ('@/' for '@/*').
        const keyPrefix = mapped.key.endsWith('/*') ? mapped.key.slice(0, -1) : mapped.key.endsWith('/') ? mapped.key : mapped.key + '/';
        const remainder = spec.startsWith(keyPrefix) ? spec.slice(keyPrefix.length) : spec;
        const base = path.posix.dirname(mapped.configRel);
        const relTarget = normalizeRel(path.posix.join(base, mapped.target.replace(/\*\s*$/, remainder)));
        return this._resolveRelative(relTarget);
      }
      // Monorepo package spec like 'pkg/sub' → try <projectDir>/pkg/sub
      const pkgRoot = this._monorepoPackage(spec, importerRel);
      if (pkgRoot) return this._resolveRelative(pkgRoot);
      return null;
    }
    // Bare specifier: try project-root relative (sibling packages / local files).
    const pkgRoot = this._monorepoPackage(spec, importerRel);
    if (pkgRoot) return this._resolveRelative(pkgRoot);
    return null;
  }

  _resolveRelative(relCandidate) {
    const base = normalizeRel(relCandidate);
    const exts = ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.json', '/index.js', '/index.mjs', '/index.ts', '/index.tsx', '/index.jsx', '/index.json'];
    for (const suffix of ['', ...exts]) {
      const candidate = base + suffix;
      if (this._exists(candidate)) return candidate;
    }
    return null;
  }

  _jsTsCandidates(spec, importerDir) {
    const base = spec.startsWith('.') ? normalizeRel(path.posix.join(importerDir, spec)) : spec;
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].map(c => normalizeRel(c));
  }

  _tsconfigMapping(alias, importerRel) {
    // Nearest tsconfig walking up from the importer's directory.
    let dir = path.posix.dirname(importerRel);
    const seen = new Set();
    while (true) {
      const cfg = normalizeRel(path.posix.join(dir, 'tsconfig.json'));
      const json = this._readConfig(cfg, () => {
        const abs = path.join(this.projectDir, ...cfg.split('/'));
        return JSON.parse(fs.readFileSync(abs, 'utf-8'));
      });
      if (json?.compilerOptions?.paths) {
        for (const [key, targets] of Object.entries(json.compilerOptions.paths)) {
          if (alias === key || (key.endsWith('/*') && alias.startsWith(key.slice(0, -1)))) {
            const target = Array.isArray(targets) ? targets[0] : targets;
            return { target: String(target || ''), configRel: cfg, key };
          }
        }
      }
      if (dir === '.' || dir === '') break;
      const next = path.posix.dirname(dir);
      if (seen.has(next)) break;
      seen.add(next);
      dir = next;
    }
    return null;
  }

  _monorepoPackage(spec, importerRel) {
    // spec 'pkg' or 'pkg/sub' resolved against <projectDir> (and importer's package dir).
    const roots = ['.', path.posix.dirname(importerRel)];
    for (const root of roots) {
      const base = normalizeRel(path.posix.join(root, spec));
      for (const cand of [base, path.posix.join(base, 'index')]) {
        for (const ext of ['', '.ts', '.tsx', '.js', '.mjs', '.json']) {
          if (this._exists(cand + ext)) return cand + ext;
        }
      }
    }
    return null;
  }

  _pythonRelativeBase(dir, up) {
    let base = dir;
    for (let i = 0; i < up; i++) base = path.posix.dirname(base === '.' ? '' : base);
    return base;
  }

  _pythonResolveModule(base, modulePath) {
    if (!modulePath) return null;
    const parts = modulePath.replace(/^\.+/, '').split('.');
    const fileCandidates = [normalizeRel(path.posix.join(base, ...parts) + '.py')];
    const pkgIndex = normalizeRel(path.posix.join(base, ...parts, '__init__.py'));
    const roots = [...fileCandidates, pkgIndex];
    for (const c of roots) if (this._exists(c)) return c;
    return null;
  }

  _pythonResolveAbsolute(modulePath) {
    const parts = modulePath.split('.');
    const hits = [];
    for (const root of ['.', 'src']) {
      const rel = normalizeRel(path.posix.join(root, ...parts) + '.py');
      if (this._exists(rel)) hits.push(rel);
      const pkg = normalizeRel(path.posix.join(root, ...parts, '__init__.py'));
      if (this._exists(pkg)) hits.push(pkg);
    }
    return [...new Set(hits)];
  }

  _rustCrateRoot(rel) {
    // Nearest ancestor with Cargo.toml, else project root.
    let dir = path.posix.dirname(rel);
    while (true) {
      if (this._exists(normalizeRel(path.posix.join(dir, 'Cargo.toml')))) return dir;
      if (dir === '.' || dir === '') return '.';
      const next = path.posix.dirname(dir);
      if (next === dir) return '.';
      dir = next;
    }
  }

  _rustResolveUse(usePath, dir, crateRoot, importerRel) {
    const segs = usePath.split('::').filter(Boolean);
    if (segs.length === 0) return null;
    if (segs[0] === 'crate') {
      return this._rustModulePath(path.posix.join(crateRoot, 'src', ...segs.slice(1)));
    }
    if (segs[0] === 'super') {
      let base = dir;
      for (let i = 0; i < segs.length - 1; i++) base = path.posix.dirname(base === '.' ? '' : base);
      return this._rustModulePath(path.posix.join(base, ...segs.slice(1)));
    }
    if (segs[0] === 'self') {
      return this._rustModulePath(path.posix.join(dir, ...segs.slice(1)));
    }
    // Crate-name reference (bin → lib): first segment matches package name.
    const crateName = this._crateName(crateRoot);
    if (crateName && segs[0] === crateName) {
      return this._rustModulePath(path.posix.join(crateRoot, 'src', ...segs.slice(1)));
    }
    // Fallback: try relative module tree + src layout.
    const local = this._rustModulePath(path.posix.join(dir, ...segs));
    if (local) return local;
    return this._rustModulePath(path.posix.join(crateRoot, 'src', ...segs));
  }

  _rustModulePath(base) {
    const rel = normalizeRel(base);
    for (const c of [`${rel}.rs`, `${rel}/mod.rs`]) {
      if (this._exists(c)) return c;
    }
    return null;
  }

  _crateName(crateRoot) {
    const cfg = normalizeRel(path.posix.join(crateRoot, 'Cargo.toml'));
    const text = this._readConfig(cfg, () => fs.readFileSync(path.join(this.projectDir, ...cfg.split('/')), 'utf-8'));
    if (typeof text === 'string') {
      const m = text.match(/^name\s*=\s*["']([^"']+)["']/m);
      return m ? m[1] : null;
    }
    return null;
  }

  _readConfig(rel, loader) {
    if (this._configCache.has(rel)) return this._configCache.get(rel);
    try {
      const parsed = loader();
      this._configCache.set(rel, parsed);
      return parsed;
    } catch {
      this._configCache.set(rel, null);
      return null;
    }
  }

  _exists(rel) {
    const normalized = normalizeRel(rel);
    if (!normalized || normalized === '.' || normalized.includes('..')) return false;
    return fs.existsSync(path.join(this.projectDir, ...normalized.split('/')));
  }

  _lineOf(content, re) {
    const m = content.match(re);
    if (!m) return 0;
    return 1 + content.slice(0, m.index).split('\n').length - 1;
  }

  // ── Edge bookkeeping ─────────────────────────────────────────────────────

  _rebuildReverseIndex() {
    this.reverseIndex = new Map();
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      if (!this.reverseIndex.has(e.to)) this.reverseIndex.set(e.to, []);
      this.reverseIndex.get(e.to).push(i);
    }
  }

  // ── Lookups ──────────────────────────────────────────────────────────────

  getImporters(fileRel) {
    const rel = normalizeRel(fileRel);
    return this.edges
      .filter(e => e.to === rel && e.status === 'resolved')
      .map(e => ({ from: e.from, kind: e.kind, line: e.line, status: e.status }));
  }

  getImports(fileRel) {
    const rel = normalizeRel(fileRel);
    return this.edges
      .filter(e => e.from === rel)
      .map(e => ({ to: e.to, kind: e.kind, line: e.line, status: e.status, candidates: e.candidates || [] }));
  }

  resolvePath(spec, importerRel) {
    const importer = normalizeRel(importerRel);
    const dir = path.posix.dirname(importer);
    const ext = path.extname(importer).toLowerCase();
    if (ext === '.py') {
      if (spec.startsWith('.')) {
        const dots = spec.match(/^\.+/)[0].length;
        const mod = spec.replace(/^\.+/, '');
        return this._pythonResolveModule(this._pythonRelativeBase(dir, dots - 1), mod);
      }
      const hits = this._pythonResolveAbsolute(spec);
      return hits.length === 1 ? hits[0] : null;
    }
    if (ext === '.rs') {
      const crateRoot = this._rustCrateRoot(importer);
      return this._rustResolveUse(spec, dir, crateRoot, importer);
    }
    return this._resolveJsTs(spec, dir, importer);
  }

  tracePath(fromRel, toRel, maxDepth = 6) {
    const from = normalizeRel(fromRel);
    const to = normalizeRel(toRel);
    if (from === to) return [];
    const adj = new Map();
    for (const e of this.edges) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from).push(e);
    }
    const queue = [[from, []]];
    const visited = new Set([from]);
    while (queue.length > 0) {
      const [node, trail] = queue.shift();
      if (trail.length > maxDepth) continue;
      for (const e of adj.get(node) || []) {
        if (e.to === to) return [...trail, e];
        if (!visited.has(e.to)) {
          visited.add(e.to);
          queue.push([e.to, [...trail, e]]);
        }
      }
    }
    return [];
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  toJSON() {
    return {
      version: GRAPH_VERSION,
      nodes: Object.fromEntries(this.nodes),
      edges: this.edges,
    };
  }

  static fromJSON(data, projectDir) {
    const g = new GraphIndexer(projectDir);
    if (!data) return g;
    g.nodes = new Map(Object.entries(data.nodes || {}));
    g.edges = Array.isArray(data.edges) ? data.edges : [];
    g._rebuildReverseIndex();
    return g;
  }

  persist(indexDir) {
    const temporary = path.join(indexDir, `.graph-${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(indexDir, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(this.toJSON()));
      fs.renameSync(temporary, path.join(indexDir, 'graph.json'));
      return true;
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* no temporary file */ }
      return false;
    }
  }

  static load(indexDir, projectDir) {
    const graphPath = path.join(indexDir, 'graph.json');
    if (!fs.existsSync(graphPath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
      return data.version === GRAPH_VERSION ? GraphIndexer.fromJSON(data, projectDir) : null;
    } catch {
      return null;
    }
  }
}