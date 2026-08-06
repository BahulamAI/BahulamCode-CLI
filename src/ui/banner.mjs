/**
 * Banner & Branding — Bahulam Code CLI startup display.
 *
 * Uses the semantic palette (`paint.brand.*`) so the same banner renders
 * correctly across truecolor, 256-color, ansi16, and monochrome terminals.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';

import { paint, strip } from './palette.mjs';
import { term } from './term.mjs';

const out = process.stderr;
const write = (s) => { try { out.write(s); } catch {} };

// ── Brand banner ─────────────────────────────────────────────────────────

function abundanceGlyph() {
  const loop = term().unicode ? '∞' : 'o';
  return [
    `  ${loop}${loop}   ${loop}${loop}  `,
    `${loop}   ${loop} ${loop}   ${loop}`,
    `${loop}    ${loop}    ${loop}`,
    `${loop}   ${loop} ${loop}   ${loop}`,
    `  ${loop}${loop}   ${loop}${loop}  `,
  ];
}

function wordmarkLines() {
  return [
    '████   ███  █   █ █   █ █      ███  █   █',
    '█   █ █   █ █   █ █   █ █     █   █ ██ ██',
    '████  █████ █████ █   █ █     █████ █ █ █',
    '█   █ █   █ █   █ █   █ █     █   █ █   █',
    '████  █   █ █   █  ███  █████ █   █ █   █',
  ];
}

/**
 * Render the branded startup banner.
 */
export function renderBanner(version = '') {
  const dim = paint.text.dim;
  const mark = abundanceGlyph();
  const wordmark = wordmarkLines();
  const code = paint.brand.data('code');
  const vTag = version ? `${dim(' · v' + version)}` : '';
  const markWidth = 11;
  const wordmarkIndent = ' '.repeat(2 + markWidth + 2);
  const lines = [''];

  for (let i = 0; i < wordmark.length; i++) {
    lines.push(`  ${paint.brand.accent(mark[i].padEnd(markWidth))}  ${paint.bold(paint.brand.primary(wordmark[i]))}`);
  }

  lines.push(`${wordmarkIndent}${code} ${dim('· abundance in your terminal')}${vTag}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Print the branded startup banner.
 */
export function printBanner(version = '') {
  write(renderBanner(version));
}

// ── Project info bar ─────────────────────────────────────────────────────

const BAR_WIDTH = 60;

/**
 * Print project info bar with version, project name, and git info.
 */
export function printProjectInfo(version) {
  const cwd = process.cwd();
  const projectName = path.basename(cwd);
  const gitInfo = getGitInfo(cwd);

  const sep = paint.text.dim(' │ ');
  let info = `  ${paint.text.dim('v' + version)}${sep}${paint.bold(projectName)}`;
  if (gitInfo) {
    info += `${sep}${paint.state.warn(gitInfo)}`;
  }

  const padCount = Math.max(0, BAR_WIDTH - strip(info).length - 1);
  const border = paint.brand.primary;

  write(`${border('┌' + '─'.repeat(BAR_WIDTH) + '┐')}\n`);
  write(`${border('│')} ${info}${' '.repeat(padCount)}${border('│')}\n`);
  write(`${border('└' + '─'.repeat(BAR_WIDTH) + '┘')}\n`);
}

// ── Hints ────────────────────────────────────────────────────────────────

export function printHints() {
  const env = process.env.TARANG_ENV || process.env.NODE_ENV || 'production';
  const dim = paint.text.dim;
  const accent = paint.brand.data;

  write(`${paint.state.success('Type your instructions')}, or ${accent('/help')} for commands\n`);
  write(`${dim('Ctrl+C')}${dim('=exit  ')}${dim('/clear')}${dim('=reset  ')}${dim('/config')}${dim('=settings  ')}${dim('/login')}${dim('=auth')}\n`);
  write(`${dim('env:' + env + '  models:configured via browser (/config)')}\n`);
  write('\n');
}

// ── Auth + config ────────────────────────────────────────────────────────

export function printAuthStatus(creds) {
  const check = paint.state.success(icons.pass);
  const cross = paint.state.danger(icons.fail);
  const dim = paint.text.dim;

  const tokenOk = !!creds.token;
  const env = process.env.TARANG_ENV || process.env.NODE_ENV || 'production';

  write(`  Auth:     ${tokenOk
    ? `${check} logged in ${dim('(/whoami for details)')}`
    : `${cross} not logged in ${dim('(/login)')}`}\n`);
  write(`  Env:      ${dim(env)}\n`);
  write(`  Mode:     ${dim(creds.mode || 'auto')}\n`);
  write('\n');
}

export function printStyledConfig(creds) {
  const check = paint.state.success(icons.pass);
  const cross = paint.state.danger(icons.fail);
  const dim = paint.text.dim;

  const mask = (val) => {
    if (!val) return `${cross} not set`;
    if (val.length <= 8) return `${check} ****`;
    return `${check} ${val.slice(0, 6)}...${val.slice(-4)}`;
  };

  const env = process.env.TARANG_ENV || process.env.NODE_ENV || 'production';

  write(`\n${paint.bold('Bahulam Code · Abundance')} ${dim('(~/.bahulam/config.json)')}\n`);
  write(`${dim('─'.repeat(50))}\n`);
  write(`  Token:          ${mask(creds.token)}\n`);
  write(`  OpenRouter:     ${mask(creds.openRouterKey)}\n`);
  write(`  Anthropic:      ${mask(creds.anthropicKey)}\n`);
  write(`  Environment:    ${dim(env)}\n`);
  write(`  Backend URL:    ${dim(creds.backendUrl)}\n`);
  write(`  Mode:           ${dim(creds.mode || 'auto')}\n`);
  write('\n');
}

export function printGoodbye() {
  write(`\n${paint.bold(paint.brand.primary('until next time — abundance awaits'))}\n\n`);
}

// ── Git probe ────────────────────────────────────────────────────────────

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

    return changes > 0 ? `⎇ ${branch} (${changes} changed)` : `⎇ ${branch}`;
  } catch {
    return null;
  }
}

// ── OAuth success page (unchanged from prior version) ────────────────────

export function getLoginSuccessHTML() {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Bahulam Code - Login Successful</title>
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
        .bahulam { color: #58a6ff; }
        .bahulam { color: #06b6d4; letter-spacing: 4px; }
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
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <span class="bahulam">BAHULAM CODE</span>
        </div>
        <div class="check">&#10003;</div>
        <h1>Login Successful!</h1>
        <p>You can close this tab and return to your terminal.</p>
    </div>
</body>
</html>`;
}
