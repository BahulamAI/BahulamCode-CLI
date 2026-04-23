/**
 * Tool Registry — validateInput/call interface.
 * Mirrors Claude Code's tool dispatch system.
 * Registers all 25+ built-in tools.
 */

import { BashTool } from './bash.mjs';
import { ReadTool } from './read.mjs';
import { EditTool } from './edit.mjs';
import { WriteTool } from './write.mjs';
import { GlobTool } from './glob.mjs';
import { GrepTool } from './grep.mjs';
import { AgentTool } from './agent.mjs';
import { WebFetchTool } from './web-fetch.mjs';
import { WebSearchTool } from './web-search.mjs';
import { TodoWriteTool } from './todo-write.mjs';
import { NotebookEditTool } from './notebook-edit.mjs';
import { MultiEditTool } from './multi-edit.mjs';
import { LsTool } from './ls.mjs';
import { ToolSearchTool } from './tool-search.mjs';
import { AskUserTool } from './ask-user.mjs';
import { EnterWorktreeTool } from './enter-worktree.mjs';
import { ExitWorktreeTool } from './exit-worktree.mjs';
import { SkillTool } from './skill.mjs';
import { SendMessageTool } from './send-message.mjs';
import { RemoteTriggerTool } from './remote-trigger.mjs';
import { CronCreateTool } from './cron-create.mjs';
import { CronDeleteTool } from './cron-delete.mjs';
import { CronListTool } from './cron-list.mjs';
import { LspTool } from './lsp.mjs';
import { ReadMcpResourceTool } from './read-mcp-resource.mjs';
import { ContextRetriever } from '../context/retriever.mjs';

// Tools that modify files — trigger index update after success
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

const BUILTIN_TOOLS = [
    BashTool,
    ReadTool,
    EditTool,
    WriteTool,
    GlobTool,
    GrepTool,
    AgentTool,
    WebFetchTool,
    WebSearchTool,
    TodoWriteTool,
    NotebookEditTool,
    MultiEditTool,
    LsTool,
    ToolSearchTool,
    AskUserTool,
    EnterWorktreeTool,
    ExitWorktreeTool,
    SkillTool,
    SendMessageTool,
    RemoteTriggerTool,
    CronCreateTool,
    CronDeleteTool,
    CronListTool,
    LspTool,
    ReadMcpResourceTool,
];

export function createToolRegistry() {
    const tools = new Map();
    for (const Tool of BUILTIN_TOOLS) {
        tools.set(Tool.name, Tool);
    }

    const registry = {
        list() {
            return [...tools.values()].map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
            }));
        },

        async call(name, input) {
            const tool = tools.get(name);
            if (!tool) throw new Error(`Unknown tool: ${name}`);
            const errors = tool.validateInput?.(input) || [];
            if (errors.length > 0) return `Validation error: ${errors.join(', ')}`;
            const result = await tool.call(input);

            // After successful file writes, update BM25 index incrementally
            // so search stays fresh within the session (~5-50ms, non-blocking)
            if (WRITE_TOOLS.has(name) && typeof result === 'string' && !result.startsWith('Error')) {
                const filePath = input.file_path;
                if (filePath) {
                    try {
                        const retriever = new ContextRetriever();
                        retriever.updateFile(filePath);
                    } catch { /* index update is best-effort */ }
                }
            }

            return result;
        },

        register(tool) {
            tools.set(tool.name, tool);
        },

        get(name) {
            return tools.get(name);
        },

        has(name) {
            return tools.has(name);
        },

        registerMcpTools(mcpTools, callFn) {
            ToolSearchTool._mcpTools = mcpTools;

            for (const mcpTool of mcpTools) {
                const wrapper = {
                    name: mcpTool.name,
                    description: mcpTool.description || '',
                    inputSchema: mcpTool.inputSchema || { type: 'object', properties: {} },
                    validateInput() { return []; },
                    async call(input) { return callFn(mcpTool.name, input); },
                };
                tools.set(mcpTool.name, wrapper);
            }
        },
    };

    ToolSearchTool._registry = registry;
    return registry;
}
