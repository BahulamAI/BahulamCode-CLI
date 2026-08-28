/**
 * Legacy lint tool wrapper.
 *
 * The active model-facing tool is `lint_check` in core/tool-executor.mjs.
 * Keep this wrapper resolver-backed so older imports cannot drift back to a
 * separate linter command table.
 */

import { BashTool } from './bash.mjs';
import { resolveLintCommand } from '../core/lint-resolver.mjs';

export const LintTool = {
    name: 'Lint',
    description: 'Run the project-aware linter or syntax checker for a file or directory.',
    inputSchema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'File or directory to lint (default: ".")',
                default: '.',
            },
            fix: {
                type: 'boolean',
                description: 'Auto-fix is not supported by the resolver-backed lint wrapper.',
                default: false,
            },
        },
    },
    validateInput(input = {}) {
        if (input.fix) return ['fix=true is not supported here; run an explicit shell command for fixes'];
        return [];
    },
    async call(input = {}) {
        const targetPath = input.path || '.';
        const lint = resolveLintCommand(targetPath, {
            projectRoot: process.cwd(),
            allowProjectScript: true,
        });
        if (!lint?.command) {
            return `No project-aware linter for path or file type: ${targetPath}`;
        }

        return await BashTool.call({
            command: lint.command,
            timeout: 30000,
            cwd: lint.cwd,
            description: `Lint: ${targetPath} (${lint.source})`,
        });
    },
    _executionPolicy: 'direct',
};
