/**
 * Git Status Tool — shows working tree status (matches Python schema).
 */
import { execSync } from 'node:child_process';

export const GitStatusTool = {
    name: 'git_status',
    description: 'Show git status — list modified, added, deleted files',
    inputSchema: {
        type: 'object',
        properties: {},
    },
    validateInput(input) {
        return [];
    },
    async call(input) {
        try {
            const cwd = input._cwd || process.cwd();
            const output = execSync('git status --short', {
                encoding: 'utf-8',
                timeout: 10_000,
                cwd,
                stdio: 'pipe',
            }).toString().trim();
            return output || '(clean)';
        } catch (err) {
            return `Error: ${err.message}`;
        }
    },
};