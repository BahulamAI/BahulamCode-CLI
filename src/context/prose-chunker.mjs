/**
 * Prose document chunker — JS port of the backend's Python chunker.
 *
 * Mirrors `codekepler-backend/app/agent/tools/shared/documents.py` so a
 * file chunked here (CLI local path) and a file chunked server-side
 * (chat upload or server `path` mode) produce byte-comparable chunks
 * with the same page/chunk numbering. Callers can slice/reference
 * chunks by (page_no, chunk_no) across surfaces.
 *
 * Constants come from Django's Phase 1 inline chunker
 * (retail/chat_uploads/services.py) — the single source of truth for
 * the whole platform.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Retriever interface — this module produces chunks; a retriever ranks
 * them. Today the CLI has one retriever (BM25 via
 * src/context/retriever.mjs). Desktop apps and richer offline setups
 * will add an embedding-backed retriever. Both consume the same chunk
 * shape produced here so the swap is transparent to callers:
 *
 *   Chunk (produced by this module):
 *     { page: number|null, chunk_no: number, text: string, tokens: number }
 *
 *   Retriever (any implementation):
 *     addSource(sourceId, chunks): void
 *     search(query, { topK, sources? }): Array<{
 *       sourceId, page, chunk_no, text, score
 *     }>
 *     removeSource(sourceId): void    // invalidate on file change
 *
 * The `read_attachment` tool talks to the retriever interface, never
 * to a specific implementation. Adding embeddings later means writing
 * an `EmbeddingRetriever` that satisfies this contract — no changes to
 * the chunker or the tool.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Divergences from Python (documented):
 *   - JS String indexing is UTF-16 code units, Python str is code points.
 *     For BMP-only text (nearly all documents) the boundaries match
 *     exactly. Non-BMP characters (emoji, some CJK) may fall a code unit
 *     off vs Python; not a correctness issue for retrieval.
 *   - TEXT_LIKE_MIMES is a JS-only superset of Python's TEXT_MIMES —
 *     the CLI has historically supported json/yaml/html/log/rst, and
 *     the chunker doesn't care about the surface syntax. Retrieval
 *     quality on structured files (json/yaml) will be worse than on
 *     prose; document that in the tool description, not here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// Byte-exact match with documents.py:29-31.
export const CHUNK_TOKENS = 800;
export const CHUNK_OVERLAP = 100;
export const CHARS_PER_TOKEN = 4;

// Strict server-parity set — same 5 mimes as documents.py.
export const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
]);
export const PDF_MIMES = new Set(['application/pdf']);
export const DOCUMENT_MIMES = new Set([...TEXT_MIMES, ...PDF_MIMES]);

// Wider set the CLI already supports at the `read_attachment` tool layer.
// Chunking works fine on any UTF-8 text — retrieval quality on structured
// formats is up to the retriever + query.
export const TEXT_LIKE_MIMES = new Set([
  ...TEXT_MIMES,
  'application/json',
  'application/x-yaml',
  'application/toml',
  'text/yaml',
  'text/html',
  'text/x-log',
  'text/x-rst',
  'text/x-restructuredtext',
]);

// Extension → mime map. Kept small and explicit — Python's
// mimetypes.guess_type varies by OS registry; this table is stable.
const EXT_TO_MIME = new Map([
  ['.txt', 'text/plain'],
  ['.log', 'text/x-log'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.mdx', 'text/markdown'],       // MDX = markdown + JSX; treat as prose for retrieval
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.json', 'application/json'],
  ['.yaml', 'application/x-yaml'],
  ['.yml', 'application/x-yaml'],
  ['.toml', 'application/toml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.rst', 'text/x-rst'],
  ['.pdf', 'application/pdf'],
]);

/**
 * Best-effort mime for a local file (extension-only, no magic-byte sniff).
 * Files with no matching extension return 'application/octet-stream',
 * consistent with Python's mimetypes.
 */
export function guessMime(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return EXT_TO_MIME.get(ext) || 'application/octet-stream';
}

/**
 * Chunk a text string with the 800/100 sliding window (character-based).
 * Byte-comparable to Python's chunk_text() — see documents.py:40.
 *
 * @param {string} text
 * @returns {Array<{chunk_no: number, text: string, tokens: number}>}
 */
export function chunkText(text) {
  if (!text) return [];
  const stepChars = (CHUNK_TOKENS - CHUNK_OVERLAP) * CHARS_PER_TOKEN;
  const window = CHUNK_TOKENS * CHARS_PER_TOKEN;
  const out = [];
  let i = 0;
  let chunkNo = 0;
  const len = text.length;
  while (i < len) {
    const segment = text.substring(i, i + window);
    const tokens = Math.max(1, Math.floor(segment.length / CHARS_PER_TOKEN));
    out.push({ chunk_no: chunkNo, text: segment, tokens });
    chunkNo += 1;
    i += stepChars;
  }
  return out;
}

/**
 * Extract per-page text from PDF bytes. Returns [{page, text}] with
 * 1-indexed page numbers. Scanned/OCR-only pages come back with empty
 * text — callers skip those (matches Python behavior).
 *
 * Uses the `pdf-parse` npm dep already in the CLI. Imported from
 * `lib/pdf-parse.js` (not the default entry) to skip the debug-hook
 * that opens a bundled test PDF at load time and fails in production.
 */
export async function extractPdfPages(buffer) {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const pageTexts = [];
  try {
    await pdfParse(buffer, {
      // pdf-parse calls this per page in page order (pageIndex is 0-based).
      // We accumulate into an array indexed by pageIndex to be defensive
      // against any out-of-order rendering.
      pagerender: async (pageData) => {
        try {
          const content = await pageData.getTextContent();
          const text = (content.items || [])
            .map(item => (typeof item.str === 'string' ? item.str : ''))
            .join(' ');
          const idx = typeof pageData.pageIndex === 'number' ? pageData.pageIndex : pageTexts.length;
          pageTexts[idx] = text;
          return text;
        } catch {
          return '';
        }
      },
    });
  } catch {
    return [];
  }
  return pageTexts.map((text, i) => ({ page: i + 1, text: text || '' }));
}

/**
 * Extract chunks from raw bytes. Returns the same shape as Python's
 * extract_from_bytes(): [{page, chunk_no, text, tokens}].
 *
 * page is null for text mimes, 1-indexed for PDF pages.
 * chunk_no is 0-indexed and monotonic across the whole document
 * (matches Python `global_chunk` behavior at documents.py:109-115).
 * Unsupported mimes return an empty array.
 *
 * @param {Buffer} buffer
 * @param {string} mime
 * @param {{textMimes?: Set<string>}} [opts] override which mimes are
 *   treated as chunkable text. Defaults to TEXT_LIKE_MIMES (CLI's
 *   permissive set). Pass TEXT_MIMES for strict server parity.
 */
export async function extractFromBytes(buffer, mime, opts = {}) {
  const normalizedMime = String(mime || '').toLowerCase();
  const textMimes = opts.textMimes || TEXT_LIKE_MIMES;

  if (textMimes.has(normalizedMime)) {
    const text = buffer.toString('utf8');
    return chunkText(text).map(c => ({
      page: null,
      chunk_no: c.chunk_no,
      text: c.text,
      tokens: c.tokens,
    }));
  }

  if (PDF_MIMES.has(normalizedMime)) {
    const pages = await extractPdfPages(buffer);
    const out = [];
    let globalChunk = 0;
    for (const { page, text } of pages) {
      if (!text || !text.trim()) continue;
      for (const c of chunkText(text)) {
        out.push({ page, chunk_no: globalChunk, text: c.text, tokens: c.tokens });
        globalChunk += 1;
      }
    }
    return out;
  }

  return [];
}

/**
 * Read a local file and chunk it. Returns { mime, chunks }; both empty
 * on unresolvable path or unsupported mime — same contract as Python's
 * extract_from_path(). Path resolution is the caller's responsibility
 * (the CLI uses projectRegistry.resolvePath to enforce workspace bounds
 * before calling here).
 *
 * @param {string} absPath  absolute, already-resolved file path
 * @param {{textMimes?: Set<string>}} [opts]
 * @returns {Promise<{mime: string, chunks: Array<object>}>}
 */
export async function extractFromPath(absPath, opts = {}) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { mime: '', chunks: [] };
  }
  if (!stat.isFile()) return { mime: '', chunks: [] };

  const mime = guessMime(absPath);
  const textMimes = opts.textMimes || TEXT_LIKE_MIMES;
  if (!textMimes.has(mime) && !PDF_MIMES.has(mime)) {
    return { mime, chunks: [] };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch {
    return { mime, chunks: [] };
  }

  const chunks = await extractFromBytes(buffer, mime, opts);
  return { mime, chunks };
}
