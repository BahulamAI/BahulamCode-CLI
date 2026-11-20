/**
 * Context Retriever — T20: Unified context retrieval with BM25.
 * Indexes project files and retrieves relevant chunks for LLM context.
 */

import { BM25Index } from './bm25.mjs';
import { SymbolIndexer } from './symbol-indexer.mjs';
import { GraphIndexer, isGraphSource } from './graph-indexer.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { indexDir as getIndexDir } from '../core/paths.mjs';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.bahulam', '.kepler', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);
const CODE_EXTS = new Set(['.js', '.mjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cpp', '.h', '.css', '.html', '.json', '.yaml', '.yml', '.toml', '.md', '.sh']);
const SYMBOL_EXTS = new Set(['.py', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.go', '.rs']);
const MAX_FILE_SIZE = 100_000; // 100KB
const CHUNK_LINES = 50;
const CHUNK_OVERLAP = 10;

function fileStamp(stat) {
    return [stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

export class ContextRetriever {
    constructor(projectDir = process.cwd()) {
        this.projectDir = projectDir;
        this.indexDir = getIndexDir(projectDir);
        this.index = null;
        this.fileStamps = new Map();
        this.symbolIndexer = null;
        this.chunkTexts = new Map(); // id → original text content
        this.graphIndexer = null; // cross-language reference graph (graph.json)
    }

    /** Build or rebuild the search index (BM25 chunks + symbol index). */
    async buildIndex() {
        const { files, graphFiles, stamps } = this._scanFiles();
        const documents = [];

        // Symbol indexer for AST-based search
        this.symbolIndexer = new SymbolIndexer();
        await this.symbolIndexer.init();

        for (const filePath of files) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const relPath = path.relative(this.projectDir, filePath);

                // BM25 chunks (existing behavior)
                const chunks = this._chunkFile(content, relPath);
                documents.push(...chunks);

                // Symbol extraction for code files
                const ext = path.extname(filePath).toLowerCase();
                if (SYMBOL_EXTS.has(ext)) {
                    await this.symbolIndexer.indexFile(relPath, content);
                }
            } catch { /* skip unreadable files */ }
        }

        this.index = new BM25Index();
        this.index.buildIndex(documents);

        // Store chunk texts for retrieval
        this.chunkTexts = new Map();
        for (const doc of documents) {
            this.chunkTexts.set(doc.id, doc.text);
        }

        // Persist
        if (!fs.existsSync(this.indexDir)) fs.mkdirSync(this.indexDir, { recursive: true });
        fs.writeFileSync(path.join(this.indexDir, 'bm25.json'), JSON.stringify(this.index.toJSON()));
        fs.writeFileSync(path.join(this.indexDir, 'chunks.json'), JSON.stringify(Object.fromEntries(this.chunkTexts)));
        fs.writeFileSync(path.join(this.indexDir, 'symbols.json'), JSON.stringify(this.symbolIndexer.toJSON()));

        // Cross-language reference graph (additive; graph.json beside bm25.json).
        this.graphIndexer = new GraphIndexer(this.projectDir);
        await this.graphIndexer.buildGraph(graphFiles);
        this.fileStamps = stamps;
        this._persistGraph();

        return { fileCount: files.length, chunkCount: documents.length, symbolCount: this.symbolIndexer.symbolCount, edgeCount: this.graphIndexer.edges.length };
    }

    /**
     * Incrementally update index for a single changed file.
     * Re-chunks the file and replaces its entries in the BM25 index.
     * ~5-50ms per file — safe to call after every edit/write.
     */
    updateFile(filePath) {
        if (!this.index) {
            if (!this.loadIndex()) return false;
        }

        const absPath = path.resolve(filePath);
        if (!this.graphIndexer) this.graphIndexer = new GraphIndexer(this.projectDir);
        this._updateFiles([absPath]);
        const stat = fs.lstatSync(absPath, { throwIfNoEntry: false });
        const tracked = CODE_EXTS.has(path.extname(absPath).toLowerCase()) || isGraphSource(absPath);
        if (tracked && stat?.isFile()) this.fileStamps.set(absPath, fileStamp(stat));
        else this.fileStamps.delete(absPath);
        this._persistGraph();
        return true;
    }

    // Editors, git and shell commands can change files outside our tool hooks.
    // Compare metadata at search time and persist all changes as one BM25 batch.
    refreshChangedFiles() {
        if (!this.index && !this.loadIndex()) return 0;
        const { stamps, graphFiles } = this._scanFiles();
        const changed = [];
        for (const [file, stamp] of stamps) {
            if (this.fileStamps.get(file) !== stamp) changed.push(file);
        }
        for (const file of this.fileStamps.keys()) {
            if (!stamps.has(file)) changed.push(file);
        }
        if (changed.length) {
            this._updateFiles(changed, { stamps, graphFiles });
            this.fileStamps = stamps;
            this._persistGraph();
        }
        return changed.length;
    }

    _persistGraph() {
        this.graphIndexer.sourceStamps = Object.fromEntries(Array.from(this.fileStamps,
            ([file, stamp]) => [path.relative(this.projectDir, file), stamp]));
        this.graphIndexer.persist(this.indexDir);
    }

    _updateFiles(files, discovery) {
        // For a checkout or migration, resolve the graph once against the final tree.
        const rebuildGraph = discovery && files.length > 1;
        const sources = new Set(files.map(file => path.relative(this.projectDir, file)));
        for (const id of this.chunkTexts.keys()) {
            if (sources.has(id) || sources.has(id.replace(/:\d+(?::[^:]*)?$/, ''))) this.chunkTexts.delete(id);
        }
        for (const file of files) {
            const rel = path.relative(this.projectDir, file);
            const present = !discovery || discovery.stamps.has(file);
            if (present && (!discovery || CODE_EXTS.has(path.extname(file).toLowerCase()))) {
                try {
                    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
                    if (stat?.isFile() && stat.size <= MAX_FILE_SIZE) {
                        for (const chunk of this._chunkFile(fs.readFileSync(file, 'utf8'), rel)) {
                            this.chunkTexts.set(chunk.id, chunk.text);
                        }
                    }
                } catch { /* unreadable or removed between discovery and read */ }
            }
            if (!rebuildGraph) this.graphIndexer.updateFile(rel, {
                fromDisk: present,
                isConfig: ['.json', '.toml', '.yaml', '.yml'].includes(path.extname(file).toLowerCase()),
            });
        }
        this.index = new BM25Index();
        this.index.buildIndex(Array.from(this.chunkTexts, ([id, text]) => ({ id, text })));
        try {
            fs.mkdirSync(this.indexDir, { recursive: true });
            fs.writeFileSync(path.join(this.indexDir, 'bm25.json'), JSON.stringify(this.index.toJSON()));
            fs.writeFileSync(path.join(this.indexDir, 'chunks.json'), JSON.stringify(Object.fromEntries(this.chunkTexts)));
        } catch { /* keep serving the in-memory index when the cache is read-only */ }
        if (rebuildGraph) this.graphIndexer.indexFiles(discovery.graphFiles);
    }

    /**
     * Add already-chunked prose content (from prose-chunker.mjs) to the
     * shared BM25 index — no re-read or re-chunking. Used by
     * `read_attachment` to make docs discoverable by `search_code` /
     * future `search_document` without a separate index.
     *
     * Chunk IDs are shaped `${sourceId}#c${chunk_no}` — the `#c`
     * separator makes them distinguishable from code IDs (which use `:`)
     * so `updateFile` for code files won't accidentally drop prose
     * chunks and vice versa.
     *
     * Re-adding the same sourceId replaces its chunks (idempotent —
     * safe to call on every `read_attachment`).
     *
     * @param {string} sourceId  stable id, usually a project-relative path
     * @param {Array<{page: (number|null), chunk_no: number, text: string, tokens?: number}>} chunks
     * @returns {number} chunks indexed
     */
    addProseChunks(sourceId, chunks) {
        if (!Array.isArray(chunks) || chunks.length === 0) return 0;
        if (!sourceId || typeof sourceId !== 'string') return 0;

        if (!this.index) {
            if (!this.loadIndex()) {
                this.index = new BM25Index();
                this.chunkTexts = new Map();
            }
        }

        // Drop prior chunks for this source (idempotent).
        const sourcePrefix = `${sourceId}#c`;
        const oldIds = new Set();
        for (const doc of this.index.docs) {
            if (doc.id.startsWith(sourcePrefix)) oldIds.add(doc.id);
        }
        for (const id of oldIds) this.chunkTexts.delete(id);

        // Collect surviving docs — reconstruct text from stored chunkTexts
        // (BM25Index only stores tf maps + lengths, not raw text).
        const remaining = [];
        for (const doc of this.index.docs) {
            if (!oldIds.has(doc.id)) {
                remaining.push({ id: doc.id, text: this.chunkTexts.get(doc.id) || '' });
            }
        }

        // Prep new prose docs — prefix indexed text with sourceId so BM25
        // gets signal from the filename (mirrors how _chunkFile embeds
        // relPath). Page tag included so page-scoped queries can hit it.
        const newDocs = chunks.map(c => {
            const id = `${sourceId}#c${c.chunk_no}`;
            const pageTag = c.page != null ? ` page:${c.page}` : '';
            const indexedText = `${sourceId}${pageTag}\n${c.text}`;
            return { id, text: indexedText };
        });

        // Rebuild — BM25 needs IDF recomputed across all docs.
        this.index = new BM25Index();
        this.index.buildIndex([...remaining, ...newDocs]);
        for (const doc of newDocs) {
            this.chunkTexts.set(doc.id, doc.text);
        }

        // Persist. Best-effort — an unwritable indexDir shouldn't fail
        // the tool call.
        try {
            if (!fs.existsSync(this.indexDir)) fs.mkdirSync(this.indexDir, { recursive: true });
            fs.writeFileSync(path.join(this.indexDir, 'bm25.json'), JSON.stringify(this.index.toJSON()));
            fs.writeFileSync(path.join(this.indexDir, 'chunks.json'), JSON.stringify(Object.fromEntries(this.chunkTexts)));
        } catch { /* best-effort persist */ }

        return newDocs.length;
    }

    /**
     * Remove all chunks belonging to a source (either code path or
     * prose sourceId). Called when a file is deleted so stale hits
     * don't linger in the index.
     */
    removeSource(sourceId) {
        if (!this.index) {
            if (!this.loadIndex()) return 0;
        }
        const oldIds = new Set();
        for (const doc of this.index.docs) {
            // Code IDs: exact match or `sourceId:` prefix (line/AST chunks).
            // Prose IDs: `sourceId#c` prefix.
            if (
                doc.id === sourceId
                || doc.id.startsWith(`${sourceId}:`)
                || doc.id.startsWith(`${sourceId}#c`)
            ) {
                oldIds.add(doc.id);
            }
        }
        if (oldIds.size === 0) return 0;
        for (const id of oldIds) this.chunkTexts.delete(id);

        const remaining = [];
        for (const doc of this.index.docs) {
            if (!oldIds.has(doc.id)) {
                remaining.push({ id: doc.id, text: this.chunkTexts.get(doc.id) || '' });
            }
        }

        this.index = new BM25Index();
        this.index.buildIndex(remaining);

        try {
            if (!fs.existsSync(this.indexDir)) fs.mkdirSync(this.indexDir, { recursive: true });
            fs.writeFileSync(path.join(this.indexDir, 'bm25.json'), JSON.stringify(this.index.toJSON()));
            fs.writeFileSync(path.join(this.indexDir, 'chunks.json'), JSON.stringify(Object.fromEntries(this.chunkTexts)));
        } catch { /* best-effort */ }

        // Graph cleanup: drop the removed source's edges and re-resolve importers.
        if (this.graphIndexer) {
            this.graphIndexer.updateFile(sourceId, { content: null });
            this.graphIndexer.persist(this.indexDir);
        }

        return oldIds.size;
    }

    /** Load persisted index. */
    loadIndex() {
        const indexPath = path.join(this.indexDir, 'bm25.json');
        const chunksPath = path.join(this.indexDir, 'chunks.json');
        const symbolsPath = path.join(this.indexDir, 'symbols.json');
        if (!fs.existsSync(indexPath)) return false;
        try {
            const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            this.index = BM25Index.fromJSON(data);

            if (fs.existsSync(chunksPath)) {
                const chunks = JSON.parse(fs.readFileSync(chunksPath, 'utf-8'));
                this.chunkTexts = new Map(Object.entries(chunks));
            }

            if (fs.existsSync(symbolsPath)) {
                const symData = JSON.parse(fs.readFileSync(symbolsPath, 'utf-8'));
                this.symbolIndexer = SymbolIndexer.fromJSON(symData);
            }
            // Upgrade only graph coverage when loading an index built with the old size limit.
            this.graphIndexer = GraphIndexer.load(this.indexDir, this.projectDir);
            if (!this.graphIndexer) {
                this.graphIndexer = new GraphIndexer(this.projectDir);
                this.graphIndexer.indexFiles(this._scanFiles().graphFiles);
                this.graphIndexer.persist(this.indexDir);
            }
            if (this.graphIndexer.sourceStamps) {
                this.fileStamps = new Map(Object.entries(this.graphIndexer.sourceStamps)
                    .map(([rel, stamp]) => [path.join(this.projectDir, rel), stamp]));
            } else {
                // Legacy caches lack source timestamps. Include removed sources
                // so the next reconciliation can discard their stale chunks.
                const sources = [...this.graphIndexer.nodes.keys()];
                for (const id of this.chunkTexts.keys()) {
                    if (!/#c\d+$/.test(id)) sources.push(id.replace(/:\d+(?::[^:]*)?$/, ''));
                }
                this.fileStamps = new Map(sources.map(rel => [path.join(this.projectDir, rel), null]));
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Search symbols (functions, classes, methods) by query.
     * Returns structured results with file:line, signature, parent class.
     */
    searchSymbols(query, topK = 5) {
        if (!this.symbolIndexer) return [];
        return this.symbolIndexer.search(query, topK);
    }

    /**
     * Format symbol search results for the agent.
     */
    formatSymbolResults(results) {
        if (!this.symbolIndexer || !results.length) return '';
        return this.symbolIndexer.formatResults(results);
    }

    /**
     * Cross-language reference graph lookups. Explicit, NOT wired into
     * search_code output — the agent calls these when it needs to answer
     * "who imports this?" or trace across the Node ⇄ Rust bridge.
     */
    getImporters(filePath) {
        this.refreshChangedFiles();
        return this.graphIndexer?.getImporters(path.relative(this.projectDir, filePath)) ?? [];
    }

    getImports(filePath) {
        this.refreshChangedFiles();
        return this.graphIndexer?.getImports(path.relative(this.projectDir, filePath)) ?? [];
    }

    resolvePath(moduleSpec, importerFile) {
        this.refreshChangedFiles();
        return this.graphIndexer?.resolvePath(moduleSpec, path.relative(this.projectDir, importerFile)) ?? null;
    }

    tracePath(fromFile, toFile) {
        this.refreshChangedFiles();
        return this.graphIndexer?.tracePath(path.relative(this.projectDir, fromFile), path.relative(this.projectDir, toFile)) ?? [];
    }

    /** Retrieve relevant context chunks for a query, with full text. */
    retrieve(query, topK = 10) {
        if (!this.index) {
            if (!this.loadIndex()) return [];
        }
        this.refreshChangedFiles();
        const results = this.index.search(query, topK);
        // Attach chunk text to results
        return results.map(r => ({
            ...r,
            text: this.chunkTexts.get(r.id) || `[File: ${r.id}]`,
        }));
    }

    /** Scan project files respecting .gitignore-like patterns. */
    _scanFiles(dir = this.projectDir, depth = 0, result = { files: [], graphFiles: [], stamps: new Map() }) {
        if (depth > 15) return result;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return result; }

        for (const entry of entries) {
            if (IGNORED_DIRS.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'target' && fs.existsSync(path.join(dir, 'Cargo.toml'))) continue;
                this._scanFiles(fullPath, depth + 1, result);
            } else if (entry.isFile()) {
                const graph = isGraphSource(entry.name);
                const code = CODE_EXTS.has(path.extname(entry.name).toLowerCase());
                if (!graph && !code) continue;
                try {
                    const stat = fs.statSync(fullPath);
                    result.stamps.set(fullPath, fileStamp(stat));
                    if (graph) result.graphFiles.push(fullPath);
                    if (code && stat.size <= MAX_FILE_SIZE) result.files.push(fullPath);
                } catch { /* file changed during discovery */ }
            }
        }
        return result;
    }

    /**
     * Chunk a file by AST boundaries (functions/classes) with line-based fallback.
     * AST-aware chunks contain complete functions/classes — not arbitrary 50-line blocks.
     */
    _chunkFile(content, relPath) {
        const lines = content.split('\n');

        // Small files: single chunk
        if (lines.length <= CHUNK_LINES) {
            return [{ id: relPath, text: `${relPath}\n${content}` }];
        }

        // Try AST-aware chunking: split at function/class boundaries
        const boundaries = this._findASTBoundaries(lines);

        if (boundaries.length > 1) {
            // AST-aware: chunk at function/class boundaries
            const chunks = [];
            for (const { name, startLine, endLine } of boundaries) {
                const chunk = lines.slice(startLine, endLine).join('\n');
                const id = `${relPath}:${startLine + 1}:${name}`;
                chunks.push({ id, text: `${relPath}:${startLine + 1} (${name})\n${chunk}` });
            }
            return chunks;
        }

        // Fallback: line-based chunking for non-code files
        const chunks = [];
        for (let i = 0; i < lines.length; i += (CHUNK_LINES - CHUNK_OVERLAP)) {
            const chunk = lines.slice(i, i + CHUNK_LINES).join('\n');
            chunks.push({ id: `${relPath}:${i + 1}`, text: `${relPath}:${i + 1}\n${chunk}` });
        }
        return chunks;
    }

    /**
     * Find function/class boundaries using regex patterns.
     * Returns array of { name, startLine, endLine }.
     */
    _findASTBoundaries(lines) {
        const boundaries = [];
        const patterns = [
            // Python: def/class (indentation-based)
            /^(?:async\s+)?def\s+(\w+)\s*\(/,
            /^class\s+(\w+)/,
            // JS/TS: function, class, export function
            /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
            /^(?:export\s+)?class\s+(\w+)/,
            // JS/TS: const fn = arrow
            /^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
            // Go: func
            /^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/,
            // Rust: fn, struct, impl
            /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
            /^(?:pub\s+)?struct\s+(\w+)/,
        ];

        let currentStart = 0;
        let currentName = '_top_level';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trimStart();
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match) {
                    // Close previous boundary
                    if (i > currentStart) {
                        boundaries.push({
                            name: currentName,
                            startLine: currentStart,
                            endLine: i,
                        });
                    }
                    currentStart = i;
                    currentName = match[1] || match[2] || 'unknown';
                    break;
                }
            }
        }

        // Close last boundary
        if (lines.length > currentStart) {
            boundaries.push({
                name: currentName,
                startLine: currentStart,
                endLine: lines.length,
            });
        }

        return boundaries;
    }
}
