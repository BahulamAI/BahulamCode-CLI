/**
 * Ink-like Terminal UI — rich terminal output without heavy dependencies.
 *
 * Features:
 * - Spinner during API calls
 * - Color tool names in yellow, errors in red, thinking in dim
 * - Code blocks with ``` detection and basic syntax coloring
 * - Markdown bold, italic, inline code rendering
 * - Status line showing model, tokens used, cost estimate
 * - Progress for tool execution (show tool name + "running...")
 */

// ANSI color codes
const COLORS = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    italic: '\x1b[3m',
    underline: '\x1b[4m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
};

const noColor = process.env.NO_COLOR === '1';

function c(color, text) {
    if (noColor) return text;
    return `${COLORS[color] || ''}${text}${COLORS.reset}`;
}

/**
 * Spinner for async operations.
 */
export class Spinner {
    constructor(message = 'Working...') {
        this.message = message;
        this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        this.frameIdx = 0;
        this.timer = null;
        this.active = false;
    }

    start() {
        if (noColor || !process.stderr.isTTY) return;
        this.active = true;
        this.timer = setInterval(() => {
            const frame = this.frames[this.frameIdx % this.frames.length];
            process.stderr.write(`\r${c('cyan', frame)} ${c('dim', this.message)}`);
            this.frameIdx++;
        }, 80);
    }

    update(message) {
        this.message = message;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.active) {
            process.stderr.write('\r\x1b[K'); // Clear line
            this.active = false;
        }
    }
}

/**
 * Highlight code blocks in markdown text.
 * @param {string} text
 * @returns {string}
 */
export function highlightCode(text) {
    if (noColor) return text;

    return text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const header = lang ? c('dim', `  ${lang}`) : '';
        const highlighted = code
            .split('\n')
            .map(line => `  ${highlightLine(line, lang)}`)
            .join('\n');
        return `${c('dim', '```')}${header}\n${highlighted}\n${c('dim', '```')}`;
    });
}

function highlightLine(line, lang) {
    if (noColor) return line;

    let result = line;

    // Strings
    result = result.replace(/(["'`])(.*?)\1/g, `${COLORS.green}$1$2$1${COLORS.reset}`);

    // Keywords (common across languages)
    const keywords = /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|def|fn|pub|use|mod)\b/g;
    result = result.replace(keywords, `${COLORS.magenta}$1${COLORS.reset}`);

    // Numbers
    result = result.replace(/\b(\d+\.?\d*)\b/g, `${COLORS.yellow}$1${COLORS.reset}`);

    // Comments
    result = result.replace(/(\/\/.*|#.*)$/, `${COLORS.gray}$1${COLORS.reset}`);

    return result;
}

/**
 * Render markdown formatting: bold, italic, inline code.
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
    if (noColor) return text;
    let result = text;

    // Bold: **text**
    result = result.replace(/\*\*(.+?)\*\*/g, `${COLORS.bold}$1${COLORS.reset}`);

    // Italic: *text*
    result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${COLORS.italic}$1${COLORS.reset}`);

    // Inline code: `text`
    result = result.replace(/`([^`]+)`/g, `${COLORS.cyan}$1${COLORS.reset}`);

    return result;
}

/**
 * Render a tool progress indicator.
 * @param {string} toolName
 * @param {string} status
 */
export function renderToolProgress(toolName, status) {
    const icon = status === 'running' ? c('yellow', '>>') : c('green', '>>');
    return `${icon} ${c('yellow', toolName)} ${c('dim', status)}`;
}

/**
 * Render a status bar with token counts and cost estimate.
 * @param {object} state
 */
export function renderStatusBar(state) {
    if (noColor || !process.stderr.isTTY) return '';
    const cols = process.stdout.columns || 80;
    const model = state.model || 'default';
    const inp = state.tokenUsage?.input || 0;
    const out = state.tokenUsage?.output || 0;
    const tokens = `in:${inp} out:${out}`;
    const turns = `turn:${state.turnCount || 0}`;

    // Cost estimate (Sonnet pricing by default)
    const costIn = (inp / 1_000_000) * 3;
    const costOut = (out / 1_000_000) * 15;
    const cost = `$${(costIn + costOut).toFixed(4)}`;

    const right = `${model} | ${tokens} | ${cost} | ${turns}`;
    const padding = Math.max(0, cols - right.length - 1);
    return c('dim', `${' '.repeat(padding)}${right}`);
}

/**
 * Render an error message.
 * @param {string} message
 */
export function renderError(message) {
    return `${c('red', 'Error:')} ${message}`;
}

/**
 * Render a warning message.
 * @param {string} message
 */
export function renderWarning(message) {
    return `${c('yellow', 'Warning:')} ${message}`;
}

/**
 * Render a success message.
 * @param {string} message
 */
export function renderSuccess(message) {
    return `${c('green', 'OK:')} ${message}`;
}

/**
 * Render thinking output (dim).
 * @param {string} text
 */
export function renderThinking(text) {
    return c('dim', text);
}

/**
 * Format a tool result for display.
 * @param {string} toolName
 * @param {string} result
 * @param {boolean} [truncate=true]
 */
export function formatToolResult(toolName, result, truncate = true) {
    const max = 500;
    const display = truncate && result.length > max
        ? result.slice(0, max) + c('dim', `\n...[${result.length - max} more chars]`)
        : result;
    return `${c('cyan', `[${toolName}]`)} ${display}`;
}

/**
 * Clear the screen.
 */
export function clearScreen() {
    process.stdout.write('\x1b[2J\x1b[H');
}

/**
 * Print a horizontal rule.
 */
export function hr() {
    const cols = process.stdout.columns || 80;
    return c('dim', '-'.repeat(cols));
}
