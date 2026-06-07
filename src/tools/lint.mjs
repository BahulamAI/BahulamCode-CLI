/**
 * Lint Tool — run linters and type checkers.
 *
 * Always safe: read-only, no side effects (unless --fix).
 * Agent should use this instead of shell("ruff check .").
 *
 * Execution: direct on host (no sandbox needed for read-only).
 * With --fix: routes through sandbox if available.
 */

import { BashTool } from './bash.mjs';

const LINTERS = {
    ruff:    { cmd: (p, fix) => `ruff check ${fix ? '--fix ' : ''}${p}`, lang: 'python' },
    mypy:    { cmd: (p) => `mypy ${p} --no-error-summary`, lang: 'python' },
    pyright: { cmd: (p) => `pyright ${p}`, lang: 'python' },
    pylint:  { cmd: (p) => `pylint ${p} --output-format=text`, lang: 'python' },
    eslint:  { cmd: (p, fix) => `eslint ${fix ? '--fix ' : ''}${p}`, lang: 'javascript' },
    tsc:     { cmd: () => 'tsc --noEmit', lang: 'typescript' },
    flake8:  { cmd: (p) => `flake8 ${p}`, lang: 'python' },
    biome:   { cmd: (p, fix) => `biome check ${fix ? '--fix ' : ''}${p}`, lang: 'javascript' },
};

export const LintTool = {
    name: 'Lint',
    description: 'Run a linter or type checker. Fast, read-only (unless --fix). Use this instead of Bash for code checking.',
    inputSchema: {
        type: 'object',
        properties: {
            tool: {
                type: 'string',
                enum: Object.keys(LINTERS),
                description: 'Which linter to run',
            },
            path: {
                type: 'string',
                description: 'File or directory to lint (default: ".")',
                default: '.',
            },
            fix: {
                type: 'boolean',
                description: 'Apply auto-fixes (default: false)',
                default: false,
            },
        },
        required: ['tool'],
    },
    validateInput(input) {
        const errors = [];
        if (!input.tool) errors.push('tool is required');
        if (input.tool && !LINTERS[input.tool]) errors.push(`Unknown linter: ${input.tool}. Supported: ${Object.keys(LINTERS).join(', ')}`);
        return errors;
    },
    async call(input) {
        const linter = LINTERS[input.tool];
        if (!linter) return `Unknown linter: ${input.tool}`;

        const targetPath = input.path || '.';
        const command = linter.cmd(targetPath, input.fix);

        const result = await BashTool.call({
            command,
            timeout: 30000, // linters should be fast
            description: `Lint: ${input.tool} ${targetPath}`,
        });

        return result;
    },
    // Metadata for execution policy
    _executionPolicy: 'direct', // no sandbox for read-only; 'contained' if fix=true
};
