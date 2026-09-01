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
import { GitDiffTool } from './git-diff.mjs';
import { GitStatusTool } from './git-status.mjs';
import { WriteProjectTool } from './write-project.mjs';
import { ReadFilesTool } from './read-files.mjs';
import { SearchFilesTool } from './search-files.mjs';
import { AnalyzeCodeTool } from './analyze-code.mjs';
import { ExploreTool, PlanTool, VerifyTool, DebugTool, RefactorTool } from './meta-tools.mjs';
import { RememberTool } from './remember.mjs';
import { GenerateImageTool } from './generate-image.mjs';
import { AnalyzeImageTool } from './analyze-image.mjs';
import { loadPluginTool } from '../plugins/executor.mjs';

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
    RememberTool,
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
    GitDiffTool,
    GitStatusTool,
    WriteProjectTool,
    ReadFilesTool,
    SearchFilesTool,
    AnalyzeCodeTool,
    AnalyzeImageTool,
    GenerateImageTool,
    ExploreTool,
    PlanTool,
    VerifyTool,
    DebugTool,
    RefactorTool,
];

export function createToolRegistry({
    pluginRegistry = null,
    stateEmit = null,
} = {}) {
    const tools = new Map();
    for (const Tool of BUILTIN_TOOLS) {
        if (Tool === AgentTool) {
            tools.set(Tool.name, {
                ...Tool,
                async call(input, options = {}) {
                    return Tool.call(input, {
                        ...options,
                        pluginRegistry: options.pluginRegistry || pluginRegistry,
                        stateEmit: options.stateEmit || stateEmit,
                    });
                },
            });
        } else {
            tools.set(Tool.name, Tool);
        }
    }

    const pluginStateHandles = new Map();
    async function pluginStateFor(pluginName) {
        if (!pluginName) return null;
        if (pluginStateHandles.has(pluginName)) return pluginStateHandles.get(pluginName);
        const { makePluginState } = await import('../plugins/state.mjs');
        const state = makePluginState(pluginName, { emit: stateEmit });
        pluginStateHandles.set(pluginName, state);
        return state;
    }

    function registerPluginToolsFromRegistry() {
        if (!pluginRegistry) return;
        for (const toolDef of pluginRegistry.listTools?.() || []) {
            const name = String(toolDef.name || '').trim();
            if (!name || tools.has(name)) continue;
            const pluginName = toolDef._plugin_name || toolDef.plugin_name || null;
            tools.set(name, {
                name,
                description: toolDef.description || '',
                inputSchema: toolDef.input_schema || toolDef.parameters || { type: 'object', properties: {} },
                validateInput() { return []; },
                async call(input, options = {}) {
                    const handler = await loadPluginTool(toolDef._plugin_dir, toolDef.handler);
                    if (!handler) {
                        return {
                            success: false,
                            output: `Plugin tool handler could not be loaded: ${name}`,
                            _tool: name,
                            _plugin: pluginName,
                        };
                    }
                    const handlerOpts = {
                        ...options,
                        pluginName,
                        get state() {
                            if (this._stateP) return this._stateP;
                            this._stateP = pluginStateFor(pluginName);
                            return this._stateP;
                        },
                    };
                    try {
                        const result = await handler.call(input || {}, handlerOpts);
                        if (result && typeof result === 'object' && 'success' in result) {
                            return { ...result, _tool: name, _plugin: pluginName };
                        }
                        return {
                            success: true,
                            output: typeof result === 'string' ? result : JSON.stringify(result),
                            _tool: name,
                            _plugin: pluginName,
                        };
                    } catch (err) {
                        return {
                            success: false,
                            output: `Plugin tool error (${name}): ${err.message}`,
                            _tool: name,
                            _plugin: pluginName,
                        };
                    }
                },
            });
        }
    }

    registerPluginToolsFromRegistry();

    const registry = {
        list() {
            return [...tools.values()].map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
            }));
        },

        async call(name, input, options = {}) {
            const tool = tools.get(name);
            if (!tool) throw new Error(`Unknown tool: ${name}`);
            const errors = tool.validateInput?.(input) || [];
            if (errors.length > 0) return `Validation error: ${errors.join(', ')}`;
            const result = await tool.call(input, options);

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
