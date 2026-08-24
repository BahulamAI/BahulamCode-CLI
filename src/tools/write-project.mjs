/**
 * Write Project Tool — batch write multiple files at once (matches Python schema).
 */
import fs from 'fs';
import path from 'path';
import { hasBeenRead, markRead } from './read.mjs';

export const WriteProjectTool = {
    name: 'write_project',
    description: 'Write multiple files at once',
    inputSchema: {
        type: 'object',
        properties: {
            files: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        content: { type: 'string', description: 'File content' },
                    },
                    required: ['path', 'content'],
                },
                description: 'Files to write',
            },
        },
        required: ['files'],
    },
    validateInput(input) {
        const errors = [];
        if (!Array.isArray(input.files) || input.files.length === 0) errors.push('files array required');
        return errors;
    },
    async call(input) {
        const results = [];
        const errors = [];
        for (const file of input.files) {
            const filePath = path.resolve(file.path || file.file_path);
            try {
                const dir = path.dirname(filePath);
                fs.mkdirSync(dir, { recursive: true });
                if (fs.existsSync(filePath) && !hasBeenRead(filePath)) {
                    // Read first for overwrites
                    const { ReadTool } = await import('./read.mjs');
                    await ReadTool.call({ file_path: filePath, limit: 1 });
                }
                fs.writeFileSync(filePath, file.content || '', 'utf-8');
                markRead(filePath);
                results.push(filePath);
            } catch (err) {
                errors.push(`${filePath}: ${err.message}`);
            }
        }
        const output = results.length > 0
            ? `Created ${results.length} file(s):\n${results.map(f => `  ✓ ${f}`).join('\n')}`
            : 'No files written';
        if (errors.length > 0) {
            return `${output}\n\nErrors:\n${errors.map(e => `  ✗ ${e}`).join('\n')}`;
        }
        return output;
    },
};