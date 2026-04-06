/**
 * LS Tool — directory listing with metadata.
 */

import fs from 'fs';
import path from 'path';

export const LsTool = {
    name: 'LS',
    description: 'List directory contents with file sizes and types.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Directory path to list (default: cwd)' },
            all: { type: 'boolean', description: 'Include hidden files (default: false)' },
        },
        required: [],
    },

    validateInput() { return []; },

    async call(input) {
        const dirPath = path.resolve(input.path || '.');

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            const results = [];

            for (const entry of entries) {
                if (!input.all && entry.name.startsWith('.')) continue;

                const fullPath = path.join(dirPath, entry.name);
                let size = '';
                try {
                    const stat = fs.statSync(fullPath);
                    size = entry.isDirectory() ? '' : formatSize(stat.size);
                } catch {
                    size = '?';
                }

                const type = entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : '-';
                results.push(`${type} ${size.padStart(8)} ${entry.name}${entry.isDirectory() ? '/' : ''}`);
            }

            if (results.length === 0) return 'Empty directory';
            return `${dirPath}:\n${results.join('\n')}`;
        } catch (err) {
            return `Error: ${err.message}`;
        }
    },
};

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}
