/**
 * Banner & Branding — Tarang CLI startup display.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';

// ANSI color helpers
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const BOLD_GREEN = '\x1b[1;32m';
const BOLD_CYAN = '\x1b[1;36m';

const BANNER_ORCA = [
    ' ██████╗  ██████╗   ██████╗  █████╗ ',
    '██╔═══██╗ ██╔══██╗ ██╔════╝ ██╔══██╗',
    '██║   ██║ ██████╔╝ ██║      ███████║',
    '██║   ██║ ██╔══██╗ ██║      ██╔══██║',
    '╚██████╔╝ ██║  ██║ ╚██████╗ ██║  ██║',
    ' ╚═════╝  ╚═╝  ╚═╝  ╚═════╝ ╚═╝  ╚═╝',
];

/**
 * Print the branded ASCII art banner.
 */
export function printBanner() {
    process.stderr.write('\n');
    for (const line of BANNER_ORCA) {
        process.stderr.write(`  ${BOLD_CYAN}${line}${RESET}\n`);
    }
    process.stderr.write(`  ${DIM}Orchestration of Composable Agents${RESET}\n`);
    process.stderr.write('\n');
}

/**
 * Print project info bar with version, project name, and git info.
 * @param {string} version
 */
export function printProjectInfo(version) {
    const cwd = process.cwd();
    const projectName = path.basename(cwd);
    const gitInfo = getGitInfo(cwd);

    const sep = `${DIM} │ ${RESET}`;
    let info = `  ${DIM}v${version}${RESET}${sep}${BOLD}${projectName}${RESET}`;
    if (gitInfo) {
        info += `${sep}${YELLOW}${gitInfo}${RESET}`;
    }

    // Draw a boxed info bar
    const barWidth = 60;
    const topBorder = `${BLUE}┌${'─'.repeat(barWidth)}┐${RESET}`;
    const bottomBorder = `${BLUE}└${'─'.repeat(barWidth)}┘${RESET}`;

    process.stderr.write(`${topBorder}\n`);
    process.stderr.write(`${BLUE}│${RESET} ${info}${' '.repeat(Math.max(0, barWidth - stripAnsi(info).length - 1))}${BLUE}│${RESET}\n`);
    process.stderr.write(`${bottomBorder}\n`);
}

/**
 * Print keyboard hints and usage tips.
 */
export function printHints() {
    const env = process.env.TARANG_ENV || process.env.NODE_ENV || 'production';

    process.stderr.write(`${GREEN}Type your instructions${RESET}, or ${CYAN}/help${RESET} for commands\n`);
    process.stderr.write(`${DIM}Ctrl+C${RESET}${DIM}=exit  ${RESET}${DIM}/clear${RESET}${DIM}=reset  ${RESET}${DIM}/config${RESET}${DIM}=settings  ${RESET}${DIM}/login${RESET}${DIM}=auth${RESET}\n`);
    process.stderr.write(`${DIM}env:${env}  models:configured via browser (/config)${RESET}\n`);
    process.stderr.write('\n');
}

/**
 * Print auth status indicators.
 * @param {object} creds - { token, openRouterKey, anthropicKey, backendUrl, mode }
 */
export function printAuthStatus(creds) {
    const check = `${GREEN}✓${RESET}`;
    const cross = `${RED}✗${RESET}`;

    const tokenOk = !!creds.token;
    const env = process.env.TARANG_ENV || process.env.NODE_ENV || 'production';

    process.stderr.write(`  Auth:     ${tokenOk ? `${check} logged in` : `${cross} not logged in ${DIM}(/login)${RESET}`}\n`);
    process.stderr.write(`  Env:      ${DIM}${env}${RESET}\n`);
    process.stderr.write(`  Mode:     ${DIM}${creds.mode || 'auto'}${RESET}\n`);
    process.stderr.write('\n');
}

/**
 * Print config in a styled format.
 * @param {object} creds
 */
export function printStyledConfig(creds) {
    const check = `${GREEN}✓${RESET}`;
    const cross = `${RED}✗${RESET}`;
    const mask = (val) => {
        if (!val) return `${cross} not set`;
        if (val.length <= 8) return `${check} ****`;
        return `${check} ${val.slice(0, 6)}...${val.slice(-4)}`;
    };

    process.stderr.write(`\n${BOLD}Orca Configuration${RESET} ${DIM}(~/.orca/config.json)${RESET}\n`);
    process.stderr.write(`${'─'.repeat(50)}\n`);
    process.stderr.write(`  Token:          ${mask(creds.token)}\n`);
    process.stderr.write(`  OpenRouter:     ${mask(creds.openRouterKey)}\n`);
    process.stderr.write(`  Anthropic:      ${mask(creds.anthropicKey)}\n`);
    const env = process.env.TARANG_ENV || process.env.NODE_ENV || 'production';
    process.stderr.write(`  Environment:    ${DIM}${env}${RESET}\n`);
    process.stderr.write(`  Backend URL:    ${DIM}${creds.backendUrl}${RESET}\n`);
    process.stderr.write(`  Mode:           ${DIM}${creds.mode || 'auto'}${RESET}\n`);
    process.stderr.write('\n');
}

/**
 * Print a goodbye message.
 */
export function printGoodbye() {
    process.stderr.write(`\n${BOLD_CYAN}Goodbye!${RESET}\n\n`);
}

/**
 * Get git branch and change count for current directory.
 * @param {string} cwd
 * @returns {string|null}
 */
function getGitInfo(cwd) {
    try {
        const branch = execSync('git branch --show-current', {
            cwd, encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (!branch) return null;

        const status = execSync('git status --porcelain', {
            cwd, encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        const changes = status ? status.split('\n').filter(Boolean).length : 0;

        if (changes > 0) {
            return `\u2387 ${branch} (${changes} changed)`;
        }
        return `\u2387 ${branch}`;
    } catch {
        return null;
    }
}

/**
 * Strip ANSI escape codes for length calculation.
 */
function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Branded HTML for OAuth success page.
 */
export function getLoginSuccessHTML() {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Orca - Login Successful</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0d1117;
            color: #c9d1d9;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
        }
        .container {
            text-align: center;
            padding: 40px;
        }
        .logo {
            font-size: 48px;
            font-weight: bold;
            margin-bottom: 8px;
        }
        .dev { color: #3fb950; }
        .orca { color: #58a6ff; }
        .check {
            font-size: 64px;
            color: #3fb950;
            margin: 24px 0;
        }
        h1 {
            color: #f0f6fc;
            font-size: 24px;
            margin: 16px 0 8px;
        }
        p {
            color: #8b949e;
            font-size: 16px;
        }
        .hint {
            margin-top: 32px;
            padding: 16px;
            background: #161b22;
            border-radius: 8px;
            border: 1px solid #30363d;
        }
        code {
            background: #1f2937;
            padding: 2px 6px;
            border-radius: 4px;
            color: #58a6ff;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <span class="dev">DEV</span>
            <span class="orca">ORCA</span>
        </div>
        <div class="check">&#10003;</div>
        <h1>Login Successful!</h1>
        <p>You can close this tab and return to your terminal.</p>
        <div class="hint">
            <p>Next step: set your API key</p>
            <code>orca config --openrouter-key YOUR_KEY</code>
        </div>
    </div>
</body>
</html>`;
}
