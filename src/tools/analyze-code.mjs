/**
 * Analyze Code Tool — AST-based structured code analysis (matches Python schema).
 */
import { analyzeCode } from '../context/ast-parser.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const AnalyzeCodeTool = {
    name: 'analyze_code',
    description:
        'Get structured analysis of one specific file: function/class names with LINE NUMBERS, imports, exports. Never pass a directory or project root.',
    inputSchema: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Path to a specific file to analyze' },
        },
        required: ['file_path'],
    },
    validateInput(input) {
        return input.file_path ? [] : ['file_path required'];
    },
    async call(input) {
        const filePath = path.resolve(input.file_path);
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (err) {
            return `Error: ${err.message}`;
        }
        if (stat.isDirectory()) {
            return `Error: analyze_code expects a file, but got directory: ${filePath}. Use list_files/search_code first, then pass a specific source file.`;
        }
        const result = analyzeCode(filePath, {
            startLine: input.start_line,
            endLine: input.end_line,
        });
        return result.summary;
    },
};