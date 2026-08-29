/**
 * Test Runner Tool — run test suites in contained environment.
 *
 * Executes in .venv/sandbox when available.
 * Agent should use this instead of shell("pytest tests/").
 *
 * Execution: contained (.venv + OS sandbox if available).
 */

import { BashTool } from './bash.mjs';

export const TestRunnerTool = {
    name: 'TestRunner',
    description: 'Run tests. Executes in project environment. Use this instead of Bash for pytest, jest, vitest, cargo test, go test.',
    inputSchema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Test command (e.g., "pytest tests/test_auth.py -v", "npm test", "cargo test")',
            },
            timeout: {
                type: 'number',
                description: 'Timeout in ms (default: 120000, max: 300000)',
                default: 120000,
            },
        },
        required: ['command'],
    },
    validateInput(input) {
        const errors = [];
        if (!input.command) errors.push('command is required');
        return errors;
    },
    async call(input) {
        const timeout = Math.min(input.timeout || 120000, 300000);

        // TODO: Wire sandbox.mjs here when sandbox execution is ready
        // For now, execute directly (same as Bash but with metadata)
        const result = await BashTool.call({
            command: input.command,
            timeout,
            description: `Test: ${input.command.slice(0, 60)}`,
        });

        return result;
    },
    _executionPolicy: 'contained',
};
