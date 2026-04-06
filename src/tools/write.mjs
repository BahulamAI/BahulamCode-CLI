/**
 * Write Tool — matches Claude Code's exact behavior.
 *
 * Features:
 * - Creates parent directories if needed
 * - Requires Read first for existing file overwrites
 * - No README creation unless explicitly asked
 */
import fs from 'fs';
import path from 'path';
import { hasBeenRead, markRead } from './read.mjs';

export const WriteTool = {
    name: 'Write',
    description: 'Write content to a file. Creates parent dirs if needed.',
    inputSchema: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
            content: { type: 'string', description: 'The content to write' },
        },
        required: ['file_path', 'content'],
    },
    validateInput(input) {
        const errors = [];
        if (!input.file_path) errors.push('file_path required');
        return errors;
    },
    async call(input) {
        const filePath = path.resolve(input.file_path);

        // Check if file already exists — require Read first for overwrites
        if (fs.existsSync(filePath)) {
            if (!hasBeenRead(filePath)) {
                return `Error: File ${filePath} already exists. You must Read it first before overwriting.`;
            }
        }

        // Create parent directory if it doesn't exist
        const dir = path.dirname(filePath);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            return `Error creating directory ${dir}: ${e.message}`;
        }

        try {
            fs.writeFileSync(filePath, input.content);
            markRead(filePath); // Mark as read after writing
            return `File written: ${filePath}`;
        } catch (e) {
            return `Error writing file: ${e.message}`;
        }
    },
};
