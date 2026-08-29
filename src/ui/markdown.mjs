/**
 * Terminal Markdown Renderer — parse markdown to ANSI-styled text.
 *
 * Supports:
 * - **bold** -> bold text
 * - *italic* -> italic text
 * - `code` -> inverse/cyan
 * - ```code block``` -> bordered box
 * - - list item -> bullet
 * - # heading -> bold + underline
 * - [link](url) -> blue underline
 * - | table | -> formatted table
 */

const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    italic: '\x1b[3m',
    underline: '\x1b[4m',
    inverse: '\x1b[7m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
};

const noColor = process.env.NO_COLOR === '1';

function a(codes, text) {
    if (noColor) return text;
    const prefix = Array.isArray(codes) ? codes.join('') : codes;
    return `${prefix}${text}${ANSI.reset}`;
}

/**
 * Render inline markdown formatting within a single line.
 * @param {string} line
 * @returns {string}
 */
export function renderInline(line) {
    if (noColor) return line;
    let result = line;

    // Bold: **text**
    result = result.replace(/\*\*(.+?)\*\*/g, (_, t) => a(ANSI.bold, t));

    // Italic: *text* (not preceded/followed by *)
    result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, t) => a(ANSI.italic, t));

    // Inline code: `text`
    result = result.replace(/`([^`]+)`/g, (_, t) => a(ANSI.cyan, t));

    // Links: [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
        return `${a([ANSI.blue, ANSI.underline], text)} ${a(ANSI.dim, `(${url})`)}`;
    });

    return result;
}

/**
 * Highlight syntax within a code line (basic keyword/string/number/comment coloring).
 * @param {string} line
 * @param {string} lang
 * @returns {string}
 */
export function highlightSyntax(line, lang) {
    if (noColor) return line;
    let result = line;

    // Strings
    result = result.replace(/(["'`])(.*?)\1/g, (m, q, s) => a(ANSI.green, `${q}${s}${q}`));

    // Keywords
    const kw = /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|def|fn|pub|use|mod|struct|enum|impl|match|type|interface)\b/g;
    result = result.replace(kw, (m) => a(ANSI.magenta, m));

    // Numbers
    result = result.replace(/\b(\d+\.?\d*)\b/g, (m) => a(ANSI.yellow, m));

    // Comments
    result = result.replace(/(\/\/.*|#.*)$/, (m) => a(ANSI.gray, m));

    return result;
}

/**
 * Render a full markdown string to ANSI terminal output.
 * Handles block-level elements (headings, code blocks, lists, tables)
 * and inline formatting.
 *
 * @param {string} text - raw markdown
 * @returns {string} - ANSI-formatted string
 */
export function renderMarkdown(text) {
    if (!text) return '';
    const lines = text.split('\n');
    const output = [];
    let inCodeBlock = false;
    let codeLang = '';
    let codeLines = [];
    let inTable = false;
    let tableRows = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Code block start/end
        if (line.trimStart().startsWith('```')) {
            if (inCodeBlock) {
                // End code block - render it
                output.push(formatCodeBlock(codeLines, codeLang));
                inCodeBlock = false;
                codeLines = [];
                codeLang = '';
                continue;
            }
            // Start code block
            inCodeBlock = true;
            codeLang = line.trimStart().slice(3).trim();
            continue;
        }

        if (inCodeBlock) {
            codeLines.push(line);
            continue;
        }

        // Table detection
        if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
            // Check if separator row
            if (/^\|[\s\-:|]+\|$/.test(line.trim())) {
                // Table separator, skip
                continue;
            }
            tableRows.push(line);
            // Check if next line is NOT a table row
            const nextLine = lines[i + 1];
            if (!nextLine || (!nextLine.trim().startsWith('|') || !nextLine.trim().endsWith('|'))) {
                // Flush table
                if (tableRows.length > 0) {
                    output.push(formatTable(tableRows));
                    tableRows = [];
                }
            }
            continue;
        }

        // Flush any pending table rows
        if (tableRows.length > 0) {
            output.push(formatTable(tableRows));
            tableRows = [];
        }

        // Headings
        const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const text = headingMatch[2];
            if (level === 1) {
                output.push(a([ANSI.bold, ANSI.underline], text));
            } else if (level === 2) {
                output.push(a(ANSI.bold, text));
            } else {
                output.push(a(ANSI.bold, text));
            }
            continue;
        }

        // Unordered list
        const listMatch = line.match(/^(\s*)([-*+])\s+(.*)/);
        if (listMatch) {
            const indent = listMatch[1];
            const content = renderInline(listMatch[3]);
            output.push(`${indent}  * ${content}`);
            continue;
        }

        // Ordered list
        const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
        if (olMatch) {
            const indent = olMatch[1];
            const num = olMatch[2];
            const content = renderInline(olMatch[3]);
            output.push(`${indent}  ${num}. ${content}`);
            continue;
        }

        // Horizontal rule
        if (/^[-*_]{3,}\s*$/.test(line)) {
            const cols = process.stdout.columns || 80;
            output.push(a(ANSI.dim, '\u2500'.repeat(Math.min(cols, 60))));
            continue;
        }

        // Blockquote
        const bqMatch = line.match(/^>\s?(.*)/);
        if (bqMatch) {
            output.push(a(ANSI.dim, `  | ${renderInline(bqMatch[1])}`));
            continue;
        }

        // Normal line with inline formatting
        output.push(renderInline(line));
    }

    // Flush remaining
    if (inCodeBlock && codeLines.length > 0) {
        output.push(formatCodeBlock(codeLines, codeLang));
    }
    if (tableRows.length > 0) {
        output.push(formatTable(tableRows));
    }

    return output.join('\n');
}

/**
 * Format a code block with a border.
 * @param {string[]} lines
 * @param {string} lang
 * @returns {string}
 */
function formatCodeBlock(lines, lang) {
    if (noColor) {
        return lines.map(l => `  ${l}`).join('\n');
    }

    const maxLen = Math.max(...lines.map(l => l.length), 20);
    const width = Math.min(maxLen + 4, (process.stdout.columns || 80) - 4);
    const top = a(ANSI.gray, `  \u250C${'─'.repeat(width)}\u2510${lang ? ` ${lang}` : ''}`);
    const bot = a(ANSI.gray, `  \u2514${'─'.repeat(width)}\u2518`);
    const body = lines.map(l => {
        const highlighted = highlightSyntax(l, lang);
        return `  ${a(ANSI.gray, '\u2502')} ${highlighted}`;
    });

    return [top, ...body, bot].join('\n');
}

/**
 * Format a markdown table.
 * @param {string[]} rows
 * @returns {string}
 */
function formatTable(rows) {
    const parsed = rows.map(r =>
        r.split('|').slice(1, -1).map(c => c.trim())
    );

    if (parsed.length === 0) return '';

    // Calculate column widths
    const colCount = parsed[0].length;
    const widths = [];
    for (let c = 0; c < colCount; c++) {
        widths.push(Math.max(...parsed.map(r => (r[c] || '').length)));
    }

    const formatted = parsed.map((row, ri) => {
        const cells = row.map((cell, ci) => cell.padEnd(widths[ci] || 0));
        const line = `  ${cells.join('  ')}`;
        return ri === 0 ? a(ANSI.bold, line) : line;
    });

    // Add separator after header
    if (formatted.length > 1) {
        const sep = widths.map(w => '─'.repeat(w)).join('──');
        formatted.splice(1, 0, a(ANSI.dim, `  ${sep}`));
    }

    return formatted.join('\n');
}
