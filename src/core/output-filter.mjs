/**
 * Output Filter — T24: Smart output filtering + auto-lint.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

const NOISE_PATTERNS = [
    /^npm WARN/,
    /^npm notice/,
    /^\s*$/,
    /^added \d+ packages?/,
    /^up to date/,
    /^[\s│├└─]+$/,  // tree drawing chars
    /^\[=+\s*\]/,   // progress bars
];

const PROFILES = {
    install: { keepLines: 20, filterNoise: true },
    test:    { keepLines: 50, keepErrors: true },
    build:   { keepLines: 30, keepErrors: true },
    run:     { keepLines: 100, filterNoise: false },
};

/** Detect shell command type. */
export function detectCommandType(command) {
    if (!command) return 'run';
    const cmd = command.toLowerCase();
    if (/\b(npm install|pip install|yarn add|pnpm add)\b/.test(cmd)) return 'install';
    if (/\b(npm test|pytest|jest|vitest|mocha|cargo test)\b/.test(cmd)) return 'test';
    if (/\b(npm run build|make|cargo build|go build|tsc)\b/.test(cmd)) return 'build';
    return 'run';
}

/** Filter shell output based on command type. */
export function filterOutput(output, command) {
    if (!output) return output;
    const type = detectCommandType(command);
    const profile = PROFILES[type];
    let lines = output.split('\n');

    if (profile.filterNoise) {
        lines = lines.filter(line => !NOISE_PATTERNS.some(p => p.test(line)));
    }

    if (profile.keepErrors) {
        const errorLines = lines.filter(l => /error|Error|ERR!|FAIL|failed/i.test(l));
        if (errorLines.length > 0) {
            // Keep all error context
            const filtered = lines.slice(-profile.keepLines);
            return filtered.join('\n');
        }
    }

    if (lines.length > profile.keepLines) {
        lines = lines.slice(-profile.keepLines);
        return `[...truncated ${output.split('\n').length - profile.keepLines} lines]\n${lines.join('\n')}`;
    }

    return lines.join('\n');
}

/** Auto-lint a file after write/edit. Returns lint output or null. */
export function autoLint(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const ext = path.extname(filePath);
    let cmd;

    try {
        if (['.js', '.mjs', '.ts', '.tsx'].includes(ext)) {
            if (fs.existsSync('node_modules/.bin/eslint')) cmd = `npx eslint "${filePath}" --no-error-on-unmatched-pattern 2>&1`;
            else if (fs.existsSync('node_modules/.bin/prettier')) cmd = `npx prettier --check "${filePath}" 2>&1`;
        } else if (ext === '.py') {
            cmd = `python3 -m py_compile "${filePath}" 2>&1`;
        } else if (ext === '.go') {
            cmd = `gofmt -l "${filePath}" 2>&1`;
        } else if (ext === '.rs') {
            cmd = `rustfmt --check "${filePath}" 2>&1`;
        }

        if (!cmd) return null;
        const output = execSync(cmd, { stdio: 'pipe', timeout: 15_000, encoding: 'utf-8' });
        return output.trim() || null;
    } catch (err) {
        return err.stdout?.toString().trim() || err.stderr?.toString().trim() || null;
    }
}
