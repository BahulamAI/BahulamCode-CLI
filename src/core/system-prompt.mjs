/**
 * System Prompt Builder — loads and merges CLAUDE.md files.
 *
 * Features:
 * - Loads CLAUDE.md from: ~/.claude/CLAUDE.md, project root, parent dirs
 * - Merges in order (global -> project -> local)
 * - Splits at cache boundary (static prefix cached, dynamic suffix not)
 * - Includes tool schemas in the system prompt
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Load all CLAUDE.md files and merge them in order.
 * @param {string} [cwd] - current working directory
 * @returns {string[]} Array of CLAUDE.md contents in merge order
 */
export function loadClaudeMdFiles(cwd = process.cwd()) {
    const files = [];

    // 1. Global: ~/.claude/CLAUDE.md
    const globalPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
    if (fs.existsSync(globalPath)) {
        try {
            files.push({ source: 'global', content: fs.readFileSync(globalPath, 'utf-8') });
        } catch { /* skip */ }
    }

    // 2. Walk from cwd up to root, collecting CLAUDE.md files
    const projectFiles = [];
    let dir = path.resolve(cwd);
    const root = path.parse(dir).root;
    while (dir !== root) {
        const candidates = [
            path.join(dir, 'CLAUDE.md'),
            path.join(dir, '.claude', 'CLAUDE.md'),
        ];
        for (const f of candidates) {
            if (fs.existsSync(f)) {
                try {
                    projectFiles.push({ source: dir, content: fs.readFileSync(f, 'utf-8'), path: f });
                } catch { /* skip */ }
            }
        }
        dir = path.dirname(dir);
    }

    // Reverse so parent dirs come first (global -> project -> local)
    projectFiles.reverse();
    files.push(...projectFiles);

    return files;
}

/**
 * Build the full system prompt from CLAUDE.md files and tool schemas.
 * @param {object} options
 * @param {string} [options.cwd] - current working directory
 * @param {Array} [options.tools] - tool definitions for schema inclusion
 * @param {string} [options.override] - override system prompt entirely
 * @param {string[]} [options.addDirs] - additional directories to search for CLAUDE.md
 * @returns {{ staticPrefix: string, dynamicSuffix: string, full: string }}
 */
export function buildSystemPrompt({ cwd, tools, override, addDirs } = {}) {
    if (override) {
        return { staticPrefix: override, dynamicSuffix: '', full: override };
    }

    const parts = ['You are an AI coding assistant.'];

    // Load CLAUDE.md files
    const mdFiles = loadClaudeMdFiles(cwd);

    // Add additional directories
    if (addDirs) {
        for (const dir of addDirs) {
            const p = path.join(dir, 'CLAUDE.md');
            if (fs.existsSync(p)) {
                try {
                    mdFiles.push({ source: dir, content: fs.readFileSync(p, 'utf-8') });
                } catch { /* skip */ }
            }
        }
    }

    for (const f of mdFiles) {
        parts.push(f.content);
    }

    // The static prefix is the base prompt + CLAUDE.md content (cacheable)
    const staticPrefix = parts.join('\n\n');

    // Dynamic suffix includes tool schemas (changes per-request)
    let dynamicSuffix = '';
    if (tools && tools.length > 0) {
        const toolSummary = tools.map(t =>
            `- ${t.name}: ${(t.description || '').slice(0, 100)}`
        ).join('\n');
        dynamicSuffix = `\n\nAvailable tools:\n${toolSummary}`;
    }

    return {
        staticPrefix,
        dynamicSuffix,
        full: staticPrefix + dynamicSuffix,
    };
}

/**
 * Convert system prompt to Anthropic cache-control format.
 * @param {string} staticPrefix
 * @param {string} dynamicSuffix
 * @returns {Array} system blocks with cache_control
 */
export function toCacheBlocks(staticPrefix, dynamicSuffix) {
    const blocks = [];

    if (staticPrefix) {
        blocks.push({
            type: 'text',
            text: staticPrefix,
            cache_control: { type: 'ephemeral' },
        });
    }

    if (dynamicSuffix) {
        blocks.push({
            type: 'text',
            text: dynamicSuffix,
        });
    }

    return blocks;
}
