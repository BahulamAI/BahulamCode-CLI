/**
 * Context Retriever — T20: Unified context retrieval with BM25.
 * Indexes project files and retrieves relevant chunks for LLM context.
 */

import { BM25Index } from './bm25.mjs';
import { SymbolIndexer } from './symbol-indexer.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { indexDir as getIndexDir } from '../core/paths.mjs';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.bahulam', '.kepler', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);
const CODE_EXTS = new Set(['.js', '.mjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cpp', '.h', '.css', '.html', '.json', '.yaml', '.yml', '.toml', '.md', '.sh']);
const SYMBOL_EXTS = new Set(['.py', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.go', '.rs']);
const MAX_FILE_SIZE = 100_000; // 100KB
const CHUNK_LINES = 50;
const CHUNK_OVERLAP = 10;

export class ContextRetriever {
    constructor(projectDir = process.cwd()) {
        this.projectDir = projectDir;
        this.indexDir = getIndexDir(projectDir);
        this.index = null;
        this.symbolIndexer = null;
        this.chunkTexts = new Map(); // id → original text content
    }

    /** Build or rebuild the search index (BM25 chunks + symbol index). */
    async buildIndex() {
        const files = this._scanFiles(this.projectDir);
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

        return { fileCount: files.length, chunkCount: documents.length, symbolCount: this.symbolIndexer.symbolCount };
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
        const relPath = path.relative(this.projectDir, absPath);

        // Remove old chunks for this file
        const oldIds = new Set();
        for (const doc of this.index.docs) {
            if (doc.id === relPath || doc.id.startsWith(relPath + ':')) {
                oldIds.add(doc.id);
            }
        }

        // Collect remaining documents (excluding old chunks for this file)
        const remainingDocs = [];
        for (const doc of this.index.docs) {
            if (!oldIds.has(doc.id)) {
                // Reconstruct text from tf map for rebuild
                remainingDocs.push({ id: doc.id, text: this.chunkTexts.get(doc.id) || '' });
            }
        }

        // Remove old chunk texts
        for (const id of oldIds) this.chunkTexts.delete(id);

        // Re-chunk if file still exists (delete = just remove)
        const newChunks = [];
        if (fs.existsSync(absPath)) {
            try {
                const content = fs.readFileSync(absPath, 'utf-8');
                newChunks.push(...this._chunkFile(content, relPath));
            } catch { /* skip unreadable */ }
        }

        // Rebuild index from remaining + new chunks
        // This is fast (~5-20ms) because BM25 build is O(n) on token count
        const allDocs = [...remainingDocs, ...newChunks];
        this.index = new BM25Index();
        this.index.buildIndex(allDocs);

        // Update chunk texts
        for (const chunk of newChunks) {
            this.chunkTexts.set(chunk.id, chunk.text);
        }

        // Persist updated index
        try {
            if (!fs.existsSync(this.indexDir)) fs.mkdirSync(this.indexDir, { recursive: true });
            fs.writeFileSync(path.join(this.indexDir, 'bm25.json'), JSON.stringify(this.index.toJSON()));
            fs.writeFileSync(path.join(this.indexDir, 'chunks.json'), JSON.stringify(Object.fromEntries(this.chunkTexts)));
        } catch { /* best-effort persist */ }

        return true;
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

    /** Retrieve relevant context chunks for a query, with full text. */
    retrieve(query, topK = 10) {
        if (!this.index) {
            if (!this.loadIndex()) return [];
        }
        const results = this.index.search(query, topK);
        // Attach chunk text to results
        return results.map(r => ({
            ...r,
            text: this.chunkTexts.get(r.id) || `[File: ${r.id}]`,
        }));
    }

    /** Scan project files respecting .gitignore-like patterns. */
    _scanFiles(dir, depth = 0) {
        if (depth > 15) return [];
        const results = [];
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

        for (const entry of entries) {
            if (entry.name.startsWith('.') && IGNORED_DIRS.has(entry.name)) continue;
            if (IGNORED_DIRS.has(entry.name)) continue;

            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...this._scanFiles(fullPath, depth + 1));
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                if (!CODE_EXTS.has(ext)) continue;
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > MAX_FILE_SIZE) continue;
                } catch { continue; }
                results.push(fullPath);
            }
        }
        return results;
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
