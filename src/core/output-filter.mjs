/**
 * Output Filter — Smart shell output filtering + auto-lint.
 * Ported from tarang-cli (Python, legacy) ws/executor.py with enhanced patterns.
 */

import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { resolveLintCommand } from './lint-resolver.mjs';

// ── Command Classification ──────────────────────────────────

const COMMAND_PROFILES = {
    install: {
        patterns: [/pip install/i, /npm install/i, /yarn add/i, /pnpm add/i, /cargo add/i, /go get/i, /brew install/i, /apt install/i],
        successLimit: 500,
        failureLimit: 2000,
        noisePatterns: [
            /^Collecting \S+/,
            /^Downloading \S+/,
            /^Installing collected/,
            /^Successfully installed/,
            /^━+/,                          // Progress bars
            /^\s*\d+%\s*\|/,              // Percentage bars
            /^Using cached/,
            /^Requirement already satisfied/,
            /^added \d+ packages?/,
            /^up to date/,
            /^npm WARN/,
            /^npm notice/,
            /^\s*$/,                        // Empty lines
        ],
        keepPatterns: [/error/i, /failed/i, /WARN(?:ING)?/i, /not found/i, /permission denied/i],
    },
    test: {
        patterns: [/pytest/i, /npm test/i, /cargo test/i, /go test/i, /jest/i, /vitest/i, /mocha/i],
        successLimit: 2000,
        failureLimit: 8000,
        noisePatterns: [
            /^\.+$/,                        // Lines of dots (pytest progress)
            /^PASSED/,
            /^\s*✓/,                        // Checkmarks
            /^\s*$/,
        ],
        keepPatterns: [/FAILED/i, /FAIL/i, /Error/i, /AssertionError/i, /Expected/i, /Actual/i, /✗/, /✘/],
    },
    build: {
        patterns: [/npm run build/i, /cargo build/i, /go build/i, /tsc/i, /webpack/i, /vite build/i, /make\b/i, /next build/i],
        successLimit: 1000,
        failureLimit: 6000,
        noisePatterns: [
            /^Compiling \S+/,
            /^Finished \S+ target/,
            /^\s*$/,
        ],
        keepPatterns: [/error/i, /warning/i],
    },
    git: {
        patterns: [/^\s*git\s+(diff|show|status)\b/i],
        successLimit: 50000,
        failureLimit: 12000,
        noisePatterns: [/^\s*$/],
        keepPatterns: [],
    },
    run: {
        patterns: [/python\s/i, /node\s/i, /go run/i, /cargo run/i, /npm start/i, /npm run dev/i],
        successLimit: 4000,
        failureLimit: 8000,
        noisePatterns: [],
        keepPatterns: [],
    },
    default: {
        patterns: [],
        successLimit: 3000,
        failureLimit: 6000,
        noisePatterns: [/^\s*$/],
        keepPatterns: [],
    },
};

/** Detect shell command type for smart filtering. */
export function detectCommandType(command) {
    if (!command) return 'default';
    for (const [type, profile] of Object.entries(COMMAND_PROFILES)) {
        if (type === 'default') continue;
        if (profile.patterns.some(p => p.test(command))) return type;
    }
    return 'default';
}

// ── Output Filtering ────────────────────────────────────────

/**
 * Filter shell output based on command type.
 * Reduces noise from install/build while preserving errors and useful output.
 *
 * @param {string} output - Raw shell output
 * @param {string} command - The command that was run
 * @param {boolean} success - Whether the command succeeded
 * @returns {{ output: string, commandType: string, truncated: boolean, originalLines: number, filteredLines: number }}
 */
export function filterOutput(output, command, success = true) {
    if (!output) return { output: '', commandType: 'default', truncated: false, originalLines: 0, filteredLines: 0 };

    const type = detectCommandType(command);
    const profile = COMMAND_PROFILES[type];
    const limit = success ? profile.successLimit : profile.failureLimit;
    const lines = output.split('\n');
    const originalLines = lines.length;

    let filteredLines = [];

    for (const line of lines) {
        // Always keep lines matching keep patterns (errors, failures)
        const shouldKeep = profile.keepPatterns.length > 0 &&
            profile.keepPatterns.some(p => p.test(line));

        // Filter out noise patterns
        const isNoise = !shouldKeep && profile.noisePatterns.length > 0 &&
            profile.noisePatterns.some(p => p.test(line));

        if (shouldKeep || !isNoise) {
            filteredLines.push(line);
        }
    }

    let filteredOutput = filteredLines.join('\n');
    let truncated = false;

    // Truncate to limit
    if (filteredOutput.length > limit) {
        filteredOutput = filteredOutput.slice(0, limit);
        const lastNewline = filteredOutput.lastIndexOf('\n');
        if (lastNewline > 0) {
            filteredOutput = filteredOutput.slice(0, lastNewline);
        }
        filteredOutput += '\n... (truncated)';
        truncated = true;
    }

    return {
        output: filteredOutput,
        commandType: type,
        truncated,
        originalLines,
        filteredLines: filteredLines.length,
    };
}

// ── Auto-Lint ───────────────────────────────────────────────

/** Auto-lint a file after write/edit. Returns lint output or null. */
export function autoLint(filePath, options = {}) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const lint = resolveLintCommand(filePath, {
        projectRoot: options.projectRoot || process.cwd(),
        projectCommands: options.projectCommands || {},
        allowProjectScript: false,
    });
    if (!lint?.command) return null;

    try {
        const output = execSync(lint.command, {
            cwd: lint.cwd,
            stdio: 'pipe',
            timeout: 15_000,
            encoding: 'utf-8',
        });
        return output.trim() || null;
    } catch (err) {
        const output = (err.stderr || err.stdout || '').toString().trim();
        return output || null;
    }
}
