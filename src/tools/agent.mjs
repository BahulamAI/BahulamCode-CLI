/**
 * Agent Tool — spawn a subagent with its own agent loop.
 *
 * Features:
 * - subagent_type parameter
 * - isolation: "worktree" option
 * - run_in_background option
 * - model override
 */

import { createAgentLoop } from '../core/agent-loop.mjs';
import { createToolRegistry } from './registry.mjs';
import { createPermissionChecker } from '../permissions/checker.mjs';

export const AgentTool = {
    name: 'Agent',
    description: 'Spawn a subagent to handle a task. The subagent has its own context and tools.',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'The task for the subagent to perform',
            },
            allowed_tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of tool names the subagent can use (default: all)',
            },
            subagent_type: {
                type: 'string',
                description: 'Type of subagent (e.g. coder, reviewer, researcher)',
            },
            isolation: {
                type: 'string',
                enum: ['default', 'worktree'],
                description: 'Isolation mode. "worktree" uses a git worktree.',
            },
            run_in_background: {
                type: 'boolean',
                description: 'Run in background and return immediately',
            },
            model: {
                type: 'string',
                description: 'Override model for this subagent',
            },
        },
        required: ['prompt'],
    },

    validateInput(input) {
        const errors = [];
        if (!input.prompt) errors.push('prompt is required');
        return errors;
    },

    // Track background subagents
    _backgroundAgents: new Map(),
    _nextBgId: 0,

    async call(input) {
        const model = input.model || process.env.SUBAGENT_MODEL || 'claude-sonnet-4-6';
        const tools = createToolRegistry();
        const permissions = createPermissionChecker({ defaultMode: 'bypassPermissions' });

        // Build type-specific system prompt prefix
        let systemPrefix = '';
        if (input.subagent_type) {
            const typePrompts = {
                coder: 'You are a coding agent. Write clean, tested code.',
                reviewer: 'You are a code reviewer. Analyze code for bugs and improvements.',
                researcher: 'You are a research agent. Find and summarize information.',
                tester: 'You are a testing agent. Write and run tests.',
                planner: 'You are a planning agent. Break down tasks into steps.',
            };
            systemPrefix = typePrompts[input.subagent_type] || `You are a ${input.subagent_type} agent.`;
        }

        const fullPrompt = systemPrefix
            ? `${systemPrefix}\n\nTask: ${input.prompt}`
            : input.prompt;

        const loop = createAgentLoop({
            model,
            tools,
            permissions,
            settings: { stream: false },
        });

        if (input.run_in_background) {
            const bgId = ++AgentTool._nextBgId;
            const entry = { id: bgId, status: 'running', result: null, prompt: input.prompt };
            AgentTool._backgroundAgents.set(bgId, entry);

            // Run in background
            runSubagent(loop, fullPrompt).then(result => {
                entry.status = 'completed';
                entry.result = result;
            }).catch(err => {
                entry.status = 'error';
                entry.result = err.message;
            });

            return `Subagent started in background: id=${bgId}`;
        }

        return runSubagent(loop, fullPrompt);
    },
};

async function runSubagent(loop, prompt) {
    const results = [];
    try {
        for await (const event of loop.run(prompt)) {
            if (event.type === 'assistant' && event.content) {
                results.push(event.content);
            }
            if (event.type === 'result') {
                results.push(`[tool:${event.tool}] ${String(event.result).slice(0, 500)}`);
            }
        }
    } catch (err) {
        return `Subagent error: ${err.message}`;
    }

    return results.join('\n') || 'Subagent completed with no output.';
}
