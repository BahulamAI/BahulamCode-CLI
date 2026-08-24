/**
 * Git Diff Tool — shows unstaged changes (matches Python schema).
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';

export const GitDiffTool = {
    name: 'git_diff',
    description: 'Show git diff of current changes — verify what was modified',
    inputSchema: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Specific file to diff (optional, defaults to all changes)' },
        },
    },
    validateInput(input) {
        return [];
    },
    async call(input) {
        try {
            const cwd = input._cwd || process.cwd();
            const fileArg = input.file_path ? ` -- "${input.file_path}"` : '';
            const output = execSync(`git diff${fileArg}`, {
                encoding: 'utf-8',
                timeout: 10_000,
                cwd,
                stdio: 'pipe',
            }).toString().trim();
            return output || '(no changes)';
        } catch (err) {
            return `Error: ${err.message}`;
        }
    },
};