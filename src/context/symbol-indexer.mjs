/**
 * Symbol Indexer — AST-based code search using tree-sitter.
 *
 * Parses source files into symbols (functions, classes, methods) with
 * signatures and line numbers. Indexes symbols in BM25 for search.
 *
 * Memory efficient: stores symbol signatures (~50 chars) not file chunks
 * (~2000 chars). One tree-sitter parse per file, O(n) on file size.
 *
 * Usage:
 *   const indexer = new SymbolIndexer();
 *   await indexer.init();  // load WASM grammars once
 *   indexer.indexFile('/path/to/file.py', content);
 *   const results = indexer.search('find_ordering_name');
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BM25Index } from './bm25.mjs';

const GRAMMAR_DIR = new URL('./grammars/', import.meta.url).pathname;

const LANG_MAP = {
    '.py': 'python',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
};

/**
 * @typedef {Object} Symbol
 * @property {string} name
 * @property {string} kind - 'function' | 'class' | 'method'
 * @property {string} file - relative path
 * @property {number} line
 * @property {number} endLine
 * @property {string} signature - e.g., "def find_ordering_name(self, name, opts)"
 * @property {string} [parent] - parent class name if method
 * @property {string} [docstring] - first line of docstring
 */

export class SymbolIndexer {
    constructor() {
        this._Parser = null;
        this._languages = {};     // ext → Language
        this._symbols = [];       // all extracted symbols
        this._symbolMap = new Map(); // id → Symbol
        this._bm25 = new BM25Index();
        this._initialized = false;
    }

    /**
     * Load tree-sitter WASM runtime + grammars. Call once per session.
     * Lazy — only loads grammars for languages actually encountered.
     */
    async init() {
        if (this._initialized) return;
        try {
            const TreeSitter = (await import('web-tree-sitter')).default;
            await TreeSitter.init();
            this._Parser = new TreeSitter();
            this._TreeSitter = TreeSitter;
            this._initialized = true;
        } catch (e) {
            // Fallback: tree-sitter not available, use regex parser
            this._initialized = false;
        }
    }

    async _getLanguage(ext) {
        if (this._languages[ext]) return this._languages[ext];
        const langName = LANG_MAP[ext];
        if (!langName || !this._TreeSitter) return null;

        // Try bundled WASM from tree-sitter-wasms package
        const wasmPaths = [
            path.join(GRAMMAR_DIR, `tree-sitter-${langName}.wasm`),
        ];

        // Also check node_modules
        try {
            const modPath = new URL(`../../node_modules/tree-sitter-wasms/out/tree-sitter-${langName}.wasm`, import.meta.url).pathname;
            wasmPaths.push(modPath);
        } catch { /* ignore */ }

        for (const p of wasmPaths) {
            try {
                if (fs.existsSync(p)) {
                    const lang = await this._TreeSitter.Language.load(p);
                    this._languages[ext] = lang;
                    return lang;
                }
            } catch { /* try next */ }
        }
        return null;
    }

    /**
     * Index a single file. Extracts symbols and adds to BM25.
     * @param {string} relPath - relative path (used as ID)
     * @param {string} content - file content
     */
    async indexFile(relPath, content) {
        const ext = path.extname(relPath).toLowerCase();
        let symbols;

        const lang = await this._getLanguage(ext);
        if (lang && this._Parser) {
            this._Parser.setLanguage(lang);
            const tree = this._Parser.parse(content);
            symbols = this._extractSymbols(tree.rootNode, relPath, ext);
            tree.delete();
        } else {
            symbols = this._regexExtract(relPath, content, ext);
        }

        for (const sym of symbols) {
            const id = `${sym.file}:${sym.line}:${sym.name}`;
            this._symbols.push(sym);
            this._symbolMap.set(id, sym);

            // BM25 document: name + signature + parent + docstring
            const text = [
                sym.name,
                sym.signature || '',
                sym.parent ? `${sym.parent}.${sym.name}` : '',
                sym.docstring || '',
                sym.file,
            ].join(' ');
            this._bm25.addDocument(id, text);
        }
    }

    /**
     * Search for symbols matching a query.
     * @param {string} query
     * @param {number} [topK=10]
     * @returns {Array<{symbol: Symbol, score: number}>}
     */
    search(query, topK = 10) {
        const results = this._bm25.search(query, topK);
        return results.map(r => ({
            symbol: this._symbolMap.get(r.id),
            score: r.score,
            id: r.id,
        })).filter(r => r.symbol);
    }

    /**
     * Format search results for the agent.
     */
    formatResults(results) {
        if (!results.length) return '';
        return results.map(r => {
            const s = r.symbol;
            const parent = s.parent ? `${s.parent}.` : '';
            const doc = s.docstring ? `  "${s.docstring}"` : '';
            return `${s.file}:${s.line}  ${parent}${s.signature || s.name}${doc}`;
        }).join('\n');
    }

    get symbolCount() { return this._symbols.length; }

    // ── Tree-sitter extraction ──

    _extractSymbols(node, file, ext) {
        const symbols = [];
        const langName = LANG_MAP[ext];

        if (langName === 'python') {
            this._walkPython(node, file, symbols, null);
        } else if (langName === 'javascript' || langName === 'typescript') {
            this._walkJS(node, file, symbols, null);
        }
        return symbols;
    }

    _walkPython(node, file, symbols, parentClass) {
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            const type = child.type;

            if (type === 'class_definition') {
                const nameNode = child.childForFieldName('name');
                const name = nameNode?.text || '';
                const bases = child.childForFieldName('superclasses')?.text || '';
                symbols.push({
                    name, kind: 'class', file,
                    line: child.startPosition.row + 1,
                    endLine: child.endPosition.row + 1,
                    signature: `class ${name}${bases ? `(${bases})` : ''}`,
                    docstring: this._pyDocstring(child),
                });
                // Recurse into class body for methods
                const body = child.childForFieldName('body');
                if (body) this._walkPython(body, file, symbols, name);
            }

            else if (type === 'function_definition') {
                const nameNode = child.childForFieldName('name');
                const name = nameNode?.text || '';
                const params = child.childForFieldName('parameters')?.text || '()';
                const returnType = child.childForFieldName('return_type')?.text || '';
                const sig = `def ${name}${params}${returnType ? ' -> ' + returnType : ''}`;
                symbols.push({
                    name,
                    kind: parentClass ? 'method' : 'function',
                    file,
                    line: child.startPosition.row + 1,
                    endLine: child.endPosition.row + 1,
                    signature: sig,
                    parent: parentClass || undefined,
                    docstring: this._pyDocstring(child),
                });
            }

            else if (type === 'decorated_definition') {
                // Unwrap decorator to get the actual definition
                for (let j = 0; j < child.childCount; j++) {
                    const inner = child.child(j);
                    if (inner.type === 'function_definition' || inner.type === 'class_definition') {
                        this._walkPython(child, file, symbols, parentClass);
                        break;
                    }
                }
            }

            else {
                // Recurse for module-level statements
                if (!parentClass && child.childCount > 0) {
                    this._walkPython(child, file, symbols, parentClass);
                }
            }
        }
    }

    _pyDocstring(defNode) {
        const body = defNode.childForFieldName('body');
        if (!body || body.childCount === 0) return '';
        const first = body.child(0);
        if (first?.type === 'expression_statement') {
            const expr = first.child(0);
            if (expr?.type === 'string' || expr?.type === 'concatenated_string') {
                const raw = expr.text;
                // Extract first line of docstring
                const content = raw.replace(/^['"`]{1,3}/, '').replace(/['"`]{1,3}$/, '');
                const firstLine = content.split('\n')[0].trim();
                return firstLine.slice(0, 120);
            }
        }
        return '';
    }

    _walkJS(node, file, symbols, parentClass) {
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            const type = child.type;

            if (type === 'class_declaration' || type === 'class') {
                const nameNode = child.childForFieldName('name');
                const name = nameNode?.text || '';
                symbols.push({
                    name, kind: 'class', file,
                    line: child.startPosition.row + 1,
                    endLine: child.endPosition.row + 1,
                    signature: `class ${name}`,
                });
                const body = child.childForFieldName('body');
                if (body) this._walkJS(body, file, symbols, name);
            }

            else if (type === 'function_declaration' || type === 'method_definition') {
                const nameNode = child.childForFieldName('name');
                const name = nameNode?.text || '';
                const params = child.childForFieldName('parameters')?.text || '()';
                symbols.push({
                    name,
                    kind: parentClass ? 'method' : 'function',
                    file,
                    line: child.startPosition.row + 1,
                    endLine: child.endPosition.row + 1,
                    signature: `${parentClass ? '' : 'function '}${name}${params}`,
                    parent: parentClass || undefined,
                });
            }

            else if (type === 'export_statement' || type === 'lexical_declaration') {
                this._walkJS(child, file, symbols, parentClass);
            }

            else if (child.childCount > 0 && !parentClass) {
                this._walkJS(child, file, symbols, parentClass);
            }
        }
    }

    // ── Regex fallback (no tree-sitter) ──

    _regexExtract(file, content, ext) {
        const symbols = [];
        const lines = content.split('\n');
        let currentClass = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            const lineNum = i + 1;
            const indent = line.length - line.trimStart().length;

            // Python
            if (ext === '.py') {
                const classMatch = trimmed.match(/^class\s+(\w+)(?:\(([^)]*)\))?/);
                if (classMatch) {
                    currentClass = classMatch[1];
                    symbols.push({
                        name: currentClass, kind: 'class', file, line: lineNum,
                        signature: `class ${currentClass}${classMatch[2] ? `(${classMatch[2]})` : ''}`,
                    });
                    continue;
                }
                const fnMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
                if (fnMatch) {
                    const isMethod = indent >= 4 && currentClass;
                    symbols.push({
                        name: fnMatch[1],
                        kind: isMethod ? 'method' : 'function',
                        file, line: lineNum,
                        signature: `def ${fnMatch[1]}(${fnMatch[2]})`,
                        parent: isMethod ? currentClass : undefined,
                    });
                    continue;
                }
                if (indent === 0 && !trimmed.startsWith('#') && trimmed) {
                    currentClass = null;
                }
            }

            // JS/TS
            if (['.js', '.mjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
                const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
                if (fnMatch) {
                    symbols.push({ name: fnMatch[1], kind: 'function', file, line: lineNum, signature: `function ${fnMatch[1]}(${fnMatch[2]})` });
                }
                const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
                if (classMatch) {
                    symbols.push({ name: classMatch[1], kind: 'class', file, line: lineNum, signature: `class ${classMatch[1]}` });
                }
            }
        }
        return symbols;
    }

    // ── Serialization ──

    toJSON() {
        return {
            symbols: this._symbols,
            bm25: this._bm25.toJSON(),
        };
    }

    static fromJSON(data) {
        const indexer = new SymbolIndexer();
        indexer._initialized = true; // don't need tree-sitter for search
        indexer._symbols = data.symbols || [];
        indexer._bm25 = BM25Index.fromJSON(data.bm25);
        for (const sym of indexer._symbols) {
            const id = `${sym.file}:${sym.line}:${sym.name}`;
            indexer._symbolMap.set(id, sym);
        }
        return indexer;
    }
}
