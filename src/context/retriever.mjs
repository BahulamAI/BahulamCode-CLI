/**
 * Context Retriever — T20: Unified context retrieval with BM25.
 * Indexes project files and retrieves relevant chunks for LLM context.
 */

import { BM25Index } from './bm25.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.orca', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);
const CODE_EXTS = new Set(['.js', '.mjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cpp', '.h', '.css', '.html', '.json', '.yaml', '.yml', '.toml', '.md', '.sh']);
const MAX_FILE_SIZE = 100_000; // 100KB
const CHUNK_LINES = 50;
const CHUNK_OVERLAP = 10;

export class ContextRetriever {
    constructor(projectDir = process.cwd()) {
        this.projectDir = projectDir;
        this.indexDir = path.join(projectDir, '.orca', 'index');
        this.index = null;
        this.chunkTexts = new Map(); // id → original text content
    }

    /** Build or rebuild the search index. */
    async buildIndex() {
        const files = this._scanFiles(this.projectDir);
        const documents = [];

        for (const filePath of files) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const relPath = path.relative(this.projectDir, filePath);
                const chunks = this._chunkFile(content, relPath);
                documents.push(...chunks);
            } catch { /* skip unreadable files */ }
        }

        this.index = new BM25Index();
        this.index.buildIndex(documents);

        // Store chunk texts for retrieval
        this.chunkTexts = new Map();
        for (const doc of documents) {
            this.chunkTexts.set(doc.id, doc.text);
        }

        // Persist index + chunk texts
        if (!fs.existsSync(this.indexDir)) fs.mkdirSync(this.indexDir, { recursive: true });
        fs.writeFileSync(path.join(this.indexDir, 'bm25.json'), JSON.stringify(this.index.toJSON()));
        fs.writeFileSync(path.join(this.indexDir, 'chunks.json'), JSON.stringify(Object.fromEntries(this.chunkTexts)));

        return { fileCount: files.length, chunkCount: documents.length };
    }

    /** Load persisted index. */
    loadIndex() {
        const indexPath = path.join(this.indexDir, 'bm25.json');
        const chunksPath = path.join(this.indexDir, 'chunks.json');
        if (!fs.existsSync(indexPath)) return false;
        try {
            const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            this.index = BM25Index.fromJSON(data);

            // Load chunk texts if available
            if (fs.existsSync(chunksPath)) {
                const chunks = JSON.parse(fs.readFileSync(chunksPath, 'utf-8'));
                this.chunkTexts = new Map(Object.entries(chunks));
            }
            return true;
        } catch {
            return false;
        }
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

    /** Chunk a file into overlapping line-based segments. */
    _chunkFile(content, relPath) {
        const lines = content.split('\n');
        if (lines.length <= CHUNK_LINES) {
            return [{ id: relPath, text: `${relPath}\n${content}` }];
        }
        const chunks = [];
        for (let i = 0; i < lines.length; i += (CHUNK_LINES - CHUNK_OVERLAP)) {
            const chunk = lines.slice(i, i + CHUNK_LINES).join('\n');
            chunks.push({ id: `${relPath}:${i + 1}`, text: `${relPath}:${i + 1}\n${chunk}` });
        }
        return chunks;
    }
}
