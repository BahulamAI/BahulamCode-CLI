/**
 * Read Files Tool — read multiple files at once (matches Python schema).
 */
import * as path from 'node:path';

export const ReadFilesTool = {
    name: 'read_files',
    description: 'Read multiple files at once',
    inputSchema: {
        type: 'object',
        properties: {
            file_paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'File paths',
            },
        },
        required: ['file_paths'],
    },
    validateInput(input) {
        return Array.isArray(input.file_paths) && input.file_paths.length > 0 ? [] : ['file_paths array required'];
    },
    async call(input) {
        const { ReadTool } = await import('./read.mjs');
        const results = [];
        for (const fp of input.file_paths) {
            try {
                const result = await ReadTool.call({ file_path: path.resolve(fp) });
                const text = typeof result === 'string' ? result : (result?.output || result?.content || String(result));
                results.push(`## ${fp}\n${text}`);
            } catch (err) {
                results.push(`## ${fp}\nError: ${err.message}`);
            }
        }
        return results.join('\n\n');
    },
};