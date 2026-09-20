/**
 * Banner & Branding — Bahulam Code CLI startup display.
 *
 * Uses the semantic palette (`paint.brand.*`) so the same banner renders
 * correctly across truecolor, 256-color, ansi16, and monochrome terminals.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';

import { paint, width } from './palette.mjs';
import { icons } from './icons.mjs';
import { wrapToLines } from './text-layout.mjs';
import { term } from './term.mjs';

const out = process.stderr;
const write = (s) => { try { out.write(s); } catch {} };

// ── Brand banner ─────────────────────────────────────────────────────────

/**
 * A compact wordmark leaves the workspace, not the logo, in the foreground.
 * Wrapping follows the current terminal width, including ASCII/plain mode.
 */
export function renderBanner(version = '') {
  const t = term();
  const separator = t.unicode ? ' · ' : ' / ';
  const heading = paint.bold(paint.brand.primary((t.unicode ? '∞ ' : '> ') + 'bahulam.'))
    + ' code' + (version ? paint.text.muted(separator + 'v' + version) : '');
  const lines = [heading, paint.text.muted('Your code. Your context. Your terminal.')];
  return '\n' + lines.flatMap(line => wrapToLines(line, Math.max(1, t.columns - 4)))
    .map(line => '  ' + line).join('\n') + '\n\n';
}

/**
 * Print the branded startup banner.
 */
export function printBanner(version = '') {
  write(renderBanner(version));
}

// ── Project info bar ─────────────────────────────────────────────────────

/** Print a width-aware project summary without oversized chrome. */
export function printProjectInfo(version) {
  const t = term();
  const projectName = path.basename(process.cwd());
  const gitInfo = getGitInfo(process.cwd());
  const separator = paint.text.dim(t.unicode ? ' · ' : ' / ');
  const info = [paint.bold(projectName), gitInfo && paint.text.muted(gitInfo), version && paint.text.dim('v' + version)]
    .filter(Boolean).join(separator);
  const barWidth = Math.max(4, Math.min(78, t.columns - 2));
  const edge = t.unicode ? ['┌', '─', '┐', '│', '└', '┘'] : ['+', '-', '+', '|', '+', '+'];
  const border = paint.text.dim;
  write(border(edge[0] + edge[1].repeat(barWidth) + edge[2]) + '\n');
  for (const line of wrapToLines(info, barWidth - 2)) {
    write(border(edge[3]) + ' ' + line + ' '.repeat(Math.max(1, barWidth - width(line) - 1)) + border(edge[3]) + '\n');
  }
  write(border(edge[4] + edge[1].repeat(barWidth) + edge[5]) + '\n');
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

    const mark = term().unicode ? '⎇ ' : '';
    return changes > 0 ? `${mark}${branch} (${changes} changed)` : `${mark}${branch}`;
  } catch {
    return null;
  }
}

// ── OAuth success page ────────────────────────────────────────────────────

export function getLoginSuccessHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Bahulam Code - Login Successful</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center; padding: 24px;
      background: #FAF9F6; color: #202331; font: 15px/1.6 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
    main { width: min(100%, 440px); }
    .brand { display: flex; align-items: baseline; gap: 10px; margin-bottom: 24px; }
    .wordmark { font-size: 24px; font-weight: 650; letter-spacing: -.06em; }
    .product, .eyebrow { color: #606472; font: 11px/1.5 ui-monospace, SFMono-Regular, monospace; text-transform: uppercase; letter-spacing: .1em; }
    .card { padding: 32px; background: #FFFFFF; border: 1px solid #DEDFE5; border-radius: 10px; }
    .check { display: grid; place-items: center; width: 40px; height: 40px; margin-bottom: 24px;
      border-radius: 50%; background: #EDF5F0; color: #28684F; font-size: 22px; }
    h1 { font-size: 24px; font-weight: 600; line-height: 1.25; letter-spacing: -.035em; margin: 10px 0 12px; }
    p { margin: 0; color: #606472; }
    .next { margin-top: 24px; border-top: 1px solid #DEDFE5; padding-top: 20px; }
    .next strong { display: block; font-size: 13px; color: #202331; margin-bottom: 4px; font-weight: 600; }
    .footer { margin-top: 20px; font-size: 12px; }
    a { color: #303BA0; text-underline-offset: 3px; }
    a:focus-visible { outline: 2px solid #555BB0; outline-offset: 4px; border-radius: 2px; }
    @media (max-width: 400px) { body { padding: 20px; } .card { padding: 24px; } }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="wordmark">bahulam.</span><span class="product">Code / CLI</span></div>
    <section class="card" aria-labelledby="title">
      <div class="check" aria-hidden="true">&#10003;</div>
      <div class="eyebrow">Connection complete</div>
      <h1 id="title">You're ready to build.</h1>
      <p>Login successful. Return to your terminal to continue with Bahulam Code.</p>
      <div class="next"><strong>Your next step</strong><p>You can close this tab. Your terminal will pick up from here.</p></div>
    </section>
    <p class="footer">Need a hand? <a href="https://bahulam.ai/docs">Read the documentation</a></p>
  </main>
</body>
</html>`;
}
