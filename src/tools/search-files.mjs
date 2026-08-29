/**
 * Search Files Tool — regex-based file content search (matches Python schema).
 */
import { spawnSync } from 'child_process';
import * as path from 'node:path';

export const SearchFilesTool = {
    name: 'search_files',
    description: 'Search file contents with regex',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Regex pattern' },
            path: { type: 'string', description: 'Directory' },
        },
        required: ['pattern'],
    },
    validateInput(input) {
        return input.pattern ? [] : ['pattern required'];
    },
    async call(input) {
        const dir = path.resolve(input.path || '.');
        try {
            const args = ['-rn', '--max-count', '10', '--max-filesize', '500K'];
            args.push('-e', input.pattern);
            args.push(dir);
            const result = spawnSync('rg', args, {
                encoding: 'utf-8',
                timeout: 15_000,
                stdio: 'pipe',
            });
            if (result.status === 0 || result.status === 1) {
                const output = (result.stdout || '').trim();
                return output || `No matches for "${input.pattern}" in ${dir}`;
            }
            return `grep error (exit ${result.status}): ${result.stderr?.trim() || 'unknown'}`;
        } catch (err) {
            return `Error: ${err.message}`;
        }
    },
};