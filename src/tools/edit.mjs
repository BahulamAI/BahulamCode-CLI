/**
 * Edit Tool — matches Claude Code's exact behavior.
 *
 * Features:
 * - replace_all parameter for global replacement
 * - Verify search string is unique (error if not)
 * - Require file was Read first (track read files)
 * - Preserve exact indentation
 */
import fs from 'fs';
import path from 'path';
import { hasBeenRead, markRead } from './read.mjs';

export const EditTool = {
    name: 'edit_file',
    description: 'Performs exact string replacements in files.',
    inputSchema: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
            search: { type: 'string', description: 'The text to replace' },
            replace: { type: 'string', description: 'The replacement text' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences', default: false },
        },
        required: ['file_path', 'search', 'replace'],
    },
    validateInput(input) {
        const errors = [];
        if (!input.file_path) errors.push('file_path required');
        if (!input.search && input.search !== '') errors.push('search is required');
        if (input.search === input.replace) errors.push('search must differ from replace');
        return errors;
    },
    async call(input) {
        const filePath = path.resolve(input.file_path);

        // Check file exists
        if (!fs.existsSync(filePath)) {
            return `Error: File not found: ${filePath}`;
        }

        // Require file was read first
        if (!hasBeenRead(filePath)) {
            return `Error: You must Read ${filePath} before editing it. Use the Read tool first.`;
        }

        let content;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch (e) {
            return `Error: ${e.message}`;
        }

        if (!content.includes(input.search)) {
            return 'Error: search string not found in file. Make sure the string matches exactly, including whitespace and indentation.';
        }

        if (input.replace_all) {
            // Replace all occurrences
            const escaped = input.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            content = content.replace(new RegExp(escaped, 'g'), input.replace);
        } else {
            // Check uniqueness: search string must appear exactly once
            const firstIdx = content.indexOf(input.search);
            const secondIdx = content.indexOf(input.search, firstIdx + 1);
            if (secondIdx !== -1) {
                const count = content.split(input.search).length - 1;
                return `Error: search string is not unique in the file (found ${count} occurrences). Provide more context to make it unique, or use replace_all to replace all occurrences.`;
            }
            content = content.replace(input.search, input.replace);
        }

        try {
            fs.writeFileSync(filePath, content);
            // Keep it marked as read
            markRead(filePath);
            return `File updated: ${filePath}`;
        } catch (e) {
            return `Error writing file: ${e.message}`;
        }
    },
};