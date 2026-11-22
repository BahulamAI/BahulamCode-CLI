/**
 * Read Tool — matches Claude Code's exact behavior.
 *
 * Features:
 * - pages parameter for PDF files
 * - Binary file detection
 * - Complete text by default, or an explicitly requested range
 * - Line number prefix (cat -n format)
 * - Graceful file not found handling
 * - Tracks read files for Edit/Write verification
 */
import fs from 'fs';
import path from 'path';

// Track which files have been read (used by Edit and Write tools)
const readFiles = new Set();

export function hasBeenRead(filePath) {
    return readFiles.has(path.resolve(filePath));
}

export function markRead(filePath) {
    readFiles.add(path.resolve(filePath));
}

// Binary detection: check for null bytes in first 8KB
function isBinary(buffer) {
    const len = Math.min(buffer.length, 8192);
    for (let i = 0; i < len; i++) {
        if (buffer[i] === 0) return true;
    }
    return false;
}

export const ReadTool = {
    name: 'read_file',
    description: 'Read a file from the local filesystem.',
    inputSchema: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
            start_line: { type: 'integer', description: 'Line number to start reading from (1-indexed)' },
            end_line: { type: 'integer', description: 'Line number to stop reading at (1-indexed, inclusive)' },
            pages: { type: 'string', description: 'Page range for PDF files (e.g. "1-5")' },
        },
        required: ['file_path'],
    },
    validateInput(input) {
        const errors = [];
        if (!input.file_path) errors.push('file_path is required');
        return errors;
    },
    async call(input) {
        const filePath = path.resolve(input.file_path);

        // Check existence
        if (!fs.existsSync(filePath)) {
            return `Error: File not found: ${filePath}`;
        }

        // Check if directory
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return `Error: ${filePath} is a directory, not a file. Use Bash with ls to list directory contents.`;
        }

        // PDF handling
        if (filePath.endsWith('.pdf')) {
            return readPdf(filePath, input.pages);
        }

        // Binary detection
        try {
            const fd = fs.openSync(filePath, 'r');
            const buf = Buffer.alloc(8192);
            const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
            fs.closeSync(fd);
            if (isBinary(buf.subarray(0, bytesRead))) {
                return `Error: ${filePath} appears to be a binary file. Cannot display binary content.`;
            }
        } catch (e) {
            return `Error: ${e.message}`;
        }

        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');

            // Track as read
            readFiles.add(filePath);

            // Handle empty files
            if (content === '' || (content.length === 0)) {
                return '[File exists but is empty]';
            }

            // start_line/end_line: 1-indexed, inclusive
            const startIdx = Math.max(0, Number(input.start_line ?? input.offset ?? 1) - 1);
            const endIdx = Math.min(lines.length, Number(input.end_line ??
                (input.limit != null ? startIdx + Number(input.limit) : lines.length)));

            const output = lines
                .slice(startIdx, endIdx)
                .map((l, i) => `${startIdx + i + 1}\t${l}`)
                .join('\n');

            if (startIdx > 0 || endIdx < lines.length) {
                return output + `\n\n[File has ${lines.length} lines total. Showing lines ${startIdx + 1}-${endIdx}. Use read_file with start_line/end_line for more.]`;
            }

            return output;
        } catch (e) {
            return `Error: ${e.message}`;
        }
    },
};

function readPdf(filePath, pages) {
    // PDF reading requires external tools; provide a best-effort
    // text extraction using a simple approach
    try {
        const { execSync } = await_import_child_process();
        const pageArg = pages ? `-f ${pages.split('-')[0]} -l ${pages.split('-').pop()}` : '-f 1 -l 20';
        const text = execSync(`pdftotext ${pageArg} "${filePath}" - 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 1024 * 1024,
        });
        return text || `[PDF file at ${filePath} — could not extract text. Use a PDF viewer.]`;
    } catch {
        return `[PDF file at ${filePath} — pdftotext not available. Install poppler-utils for PDF support.]`;
    }
}

// Lazy import helper
function await_import_child_process() {
    return require('child_process');
}
