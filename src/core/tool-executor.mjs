/**
 * Tool Executor Bridge — maps Bahulam backend tool names to OCC tool calls.
 *
 * The Bahulam backend sends tool_request events with its own tool names and arg shapes.
 * This bridge translates those into OCC tool calls and wraps the results.
 *
 * Safety guardrails integrated — prevents destructive operations on source code.
 * Tools are mapped across file, search, shell, validation, and Git operations.
 */

import { createToolRegistry } from '../tools/registry.mjs';
import { detectCommandType, filterOutput } from './output-filter.mjs';
import { isSensitiveConfigPath, validatePath, validateDelete, validateShellCommand, validateWrite } from './safety.mjs';
import { classifyCommand, isExitCodeError } from '../permissions/command-classifier.mjs';
import { analyzeCode } from '../context/ast-parser.mjs';
import { ProjectRegistry } from '../tools/project-overview.mjs';
import { SkillInstaller } from '../skills/installer.mjs';
import { SkillsLoader } from '../skills/loader.mjs';
import { createAgentFile, listLocalAgents, syncAgentsToBackend } from '../agents/scaffold.mjs';
import { compactAgentMetadata, createAgentRegistry } from '../agents/registry.mjs';
import { createWorkflowFile, listLocalWorkflows, WORKFLOW_SYNC_ENDPOINT, slugifyWorkflowName } from '../agents/workflow_scaffold.mjs';
import { BahulamAuth } from '../auth/bahulam-auth.mjs';
import { detectImageFile } from './attachments.mjs';
import { streamResponse } from './streaming.mjs';
import { sendApprovalDecision, sendCallback } from './callback-client.mjs';
import { HookRunner } from '../config/hook-runner.mjs';
import { buildFileDiff } from './file-diff.mjs';
import { buildWorkScope } from './work-scope.mjs';
import { loadDiskMemory, ensureBahulamDir, globalMemoryPath, projectMemoryPath } from './memory-disk.mjs';
import { backgroundTasks } from './background-tasks.mjs';
import { resolveLintCommand } from './lint-resolver.mjs';
import { PluginRegistry } from '../plugins/registry.mjs';
import { loadPluginTool } from '../plugins/executor.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { exec, execSync } from 'node:child_process';

/**
 * Create a tool executor that bridges Bahulam tool names to OCC tools.
 * @param {Object} [options]
 * @param {ProjectRegistry} [options.projectRegistry] - session-owned project registry
 * @returns {{ execute(name, args): Promise<Object>, listTools(): string[] }}
 */
export function createToolExecutor({
    projectRegistry = new ProjectRegistry(),
    skillsLoader = new SkillsLoader().load(process.cwd()),
    skillInstaller = null,
    checkpoints = null,
    hookRunner = null,
    interactionHandler = null,
    onAutoRegisterStart = null,
    onAutoRegisterDone = null,
    pluginRegistry = null,
    // Optional emit hook: called (debounced per key) after any plugin
    // state write commits. Wired by the workspace server so writes turn
    // into SSE `plugin_state_changed` events for live view updates.
    // REPL/headless callers leave this null — state still works, just
    // no reactive pulse.
    stateEmit = null,
    delegateRunner = null,
    // Execution channel. 'main' (REPL/headless/CLI): plugin agents are
    // workspace-scoped and excluded from listings and the agent-context
    // envelope unless allowlisted in settings plugins.agent_allowlist.
    // 'workspace' (plugin workspace sessions via agent-relay): the
    // session plugin's agents are fully available.
    channel = 'main',
} = {}) {
    // Cross-session memory cache. Ships in getAgentContext() on every turn,
    // so we need it to be byte-identical when the underlying disk file hasn't
    // changed — otherwise the backend's prompt cache invalidates on every
    // ExecuteRequest.
    //
    // Strategy: mtime-driven cache. Read the mtimes of the global +
    // project memory files; if unchanged since the last call, return the
    // cached snapshot. The `remember` tool writes to disk directly, which
    // bumps mtime and forces a reload on the next getAgentContext() call.
    //
    // Self-heal ~/.bahulam/ once at construction; loadDiskMemory() also
    // guards it, but doing it here means the first read is a plain fs stat
    // rather than a mkdir round-trip.
    try { ensureBahulamDir('global'); } catch { /* ignore */ }
    let activeDelegateRunner = delegateRunner;
    const agentRegistry = createAgentRegistry({
        cwd: () => process.cwd(),
        pluginRegistry,
        channel,
    });
    let _memoryCache = null; // { key: string, facts: Fact[], digest: string }
    function _readMemorySnapshot() {
        const gPath = globalMemoryPath();
        const pPath = projectMemoryPath(process.cwd());
        const gStat = fs.existsSync(gPath) ? fs.statSync(gPath).mtimeMs : 0;
        const pStat = fs.existsSync(pPath) ? fs.statSync(pPath).mtimeMs : 0;
        const key = `${gStat}|${pStat}|${process.cwd()}`;
        if (_memoryCache && _memoryCache.key === key) return _memoryCache;
        const facts = loadDiskMemory(process.cwd());
        const digest = crypto.createHash('sha256')
            .update(JSON.stringify(facts.map(f => [f.fact_id, f.content, f.updated_at])))
            .digest('hex').slice(0, 16);
        _memoryCache = { key, facts, digest };
        return _memoryCache;
    }
    const occRegistry = createToolRegistry({ pluginRegistry, stateEmit });
    const skillTool = occRegistry.get('Skill');
    if (skillTool) skillTool._skillsLoader = skillsLoader;
    const installer = skillInstaller || new SkillInstaller({
        cwd: process.cwd(),
        homeDir: skillsLoader.homeDir || os.homedir(),
    });

    // ── Auto-register the current working directory as a project ──
    // Without this, shell / list_files / read_attachment fail with
    // "No projects registered. Call get_project_overview first." on
    // any fresh folder — including a legitimate user CWD they just
    // cd'd into to start work. The model then has to spend a turn
    // registering before it can do anything, which is a poor first-run
    // UX. Fire-and-forget: if registration fails (permissions, weird
    // FS), the model can still call get_project_overview explicitly.
    // bypassProjectMarkers=true because we don't require a .git etc.
    // for the current directory to be usable — the user chose to be here.
    // Opt out via BAHULAM_SKIP_AUTO_REGISTER=true for tests or headless
    // scripts that want a truly empty registry.
    let autoRegisterPromise = Promise.resolve(null);
    if (process.env.BAHULAM_SKIP_AUTO_REGISTER !== 'true') {
        const autoRegisterRoot = process.cwd();
        try { onAutoRegisterStart?.(autoRegisterRoot); } catch { /* status hooks are best-effort */ }
        autoRegisterPromise = projectRegistry.register(autoRegisterRoot, { bypassProjectMarkers: true })
            .then((result) => {
                try { onAutoRegisterDone?.(null, result); } catch { /* status hooks are best-effort */ }
                return result;
            })
            .catch((err) => {
                try { onAutoRegisterDone?.(err, null); } catch { /* status hooks are best-effort */ }
                return null;
            });
    }
    let _searchCodeUsed = false; // tracks if search_code was called (for read_file nudge)
    let _readOnlyCacheGeneration = 0;
    const readOnlyResultCache = new Map();

    function resolvePath(p, args = {}, options = {}) {
        return projectRegistry.resolvePath(p, args.project_id, options);
    }

    function projectRootFor(filePath) {
        const project = projectRegistry.projectForPath(filePath);
        if (!project) throw new Error(`No registered project contains path: ${filePath}`);
        return project.resource.root;
    }

    async function commandCwd(args = {}) {
        return await resolvePath(args.cwd || null, args);
    }

    function shellTargetPath(cwd, target) {
        const value = String(target || '');
        if (value === '~') return os.homedir();
        if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
        return path.resolve(cwd, value);
    }

    function blockedShellOutput(reason) {
        const text = String(reason || 'Blocked by shell safety policy').trim();
        const hint = /command substitution|backticks|\$\(/i.test(text)
            ? 'Retry with separate simple shell commands instead of backticks or $().'
            : 'Work only inside a registered project root.';
        return `BLOCKED: ${text}. ${hint}`;
    }

    function longRunningObservationTimeoutMs() {
        const configured = Number(process.env.BAHULAM_LONG_RUNNING_TIMEOUT_MS);
        return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
    }

    function isLikelyLongRunningCommand(command) {
        const cmd = String(command || '').trim();
        if (!cmd) return false;
        if (/^(?:timeout|gtimeout)\s+\S+\s+/i.test(cmd)) return false;
        if (/(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b/i.test(cmd)) return true;
        if (/(?:^|[;&|]\s*)(?:vite|next|nuxt|astro|webpack-dev-server)\b/i.test(cmd)) return true;
        if (/\b(?:uvicorn|gunicorn|flask\s+run|rails\s+server|bin\/rails\s+server|django-admin\s+runserver|manage\.py\s+runserver)\b/i.test(cmd)) return true;
        if (/\b(?:python|python3)\s+-m\s+http\.server\b/i.test(cmd)) return true;
        if (/\bnode\b[\s\S]*(?:setInterval|\.listen\s*\(|createServer\s*\()/i.test(cmd)) return true;
        if (/\b(?:docker\s+compose|docker-compose)\s+up\b(?![\s\S]*\s-d\b)/i.test(cmd)) return true;
        if (/\btail\s+-f\b/i.test(cmd)) return true;
        if (/\b(?:--watch|watch)\b/i.test(cmd)) return true;
        return false;
    }

    function limitTail(text, maxChars = 8000) {
        const value = String(text || '');
        if (value.length <= maxChars) return value;
        return `... (tail truncated)\n${value.slice(value.length - maxChars)}`;
    }

    function isAbortError(err) {
        return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
    }

    function throwIfAborted(signal) {
        if (!signal?.aborted) return;
        const err = new Error('Cancelled by user');
        err.name = 'AbortError';
        throw err;
    }

    function cancelledToolResult(name) {
        return {
            success: false,
            output: 'Cancelled by user',
            _tool: name,
            _cancelled: true,
        };
    }

    function skillScope(args = {}) {
        const scope = String(args.scope || '').trim();
        if (scope !== 'project' && scope !== 'global') {
            throw new Error('scope must be "project" or "global"');
        }
        return scope;
    }

    function reloadSkillCatalog() {
        skillsLoader.load(installer.cwd || process.cwd());
        return skillsLoader.list();
    }

    function normalizeAgentTools(tools) {
        if (Array.isArray(tools) && tools.length > 0) {
            return tools.map(tool => String(tool).trim()).filter(Boolean);
        }
        if (typeof tools === 'string' && tools.trim()) {
            return tools.split(',').map(tool => tool.trim()).filter(Boolean);
        }
        return ['read_file', 'search_code', 'list_files'];
    }

    function listRunnables() {
        return agentRegistry.listRunnables();
    }

    function listAvailableAgents() {
        return agentRegistry.listAvailableAgents();
    }

    function filterLocalAgents(args = {}) {
        return agentRegistry.filterAgents(args);
    }

    function selectAgentsForSync(args = {}) {
        const target = String(args.name || args.slug || '').trim();
        const agents = listLocalAgents(process.cwd());
        if (!target) return agents;
        return agents.filter(agent => (
            agent.slug === target ||
            String(agent.name || '').toLowerCase() === target.toLowerCase()
        ));
    }

    function compactWorkflowMetadata(workflow) {
        return {
            slug: workflow.slug,
            name: workflow.name,
            description: workflow.description || '',
            pattern: workflow.pattern || workflow.orchestration_pattern || 'sequential',
            agent_count: workflow.agent_count || (workflow.graph?.nodes || []).filter(node => node.type === 'agent').length,
            edge_count: workflow.edge_count || (workflow.graph?.edges || []).length,
            source: workflow.filePath || workflow.source || '',
            source_scope: workflow.source_scope || 'project',
        };
    }

    function filterLocalWorkflows(args = {}) {
        const query = String(args.query || args.name || args.slug || '').trim().toLowerCase();
        return listLocalWorkflows(process.cwd())
            .filter(workflow => {
                if (!query) return true;
                return [
                    workflow.slug,
                    workflow.name,
                    workflow.description,
                    workflow.pattern,
                    ...(Array.isArray(workflow.agents) ? workflow.agents.map(a => a.slug || a.label || a.name) : []),
                ].some(value => String(value || '').toLowerCase().includes(query));
            });
    }

    function selectWorkflowsForSync(args = {}) {
        const target = String(args.name || args.slug || '').trim();
        const workflows = listLocalWorkflows(process.cwd());
        if (!target) return workflows;
        return workflows.filter(workflow => (
            workflow.slug === target ||
            String(workflow.name || '').toLowerCase() === target.toLowerCase()
        ));
    }

    function workflowTargetMatches(workflow, target) {
        const needle = String(target || '').trim().toLowerCase();
        if (!needle) return false;
        return [
            workflow.id,
            workflow.slug,
            workflow.name,
        ].some(value => String(value || '').toLowerCase() === needle);
    }

    async function resolveWorkflowId(creds, target) {
        const trimmed = String(target || '').trim();
        if (!trimmed) return null;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
            return trimmed;
        }
        if (!creds.backendUrl || !creds.token) return null;
        const resp = await fetch(`${creds.backendUrl}${WORKFLOW_SYNC_ENDPOINT}`, {
            headers: {
                Authorization: `Bearer ${creds.token}`,
                Accept: 'application/json',
            },
        });
        if (!resp.ok) return null;
        const payload = await resp.json().catch(() => ({}));
        const workflows = Array.isArray(payload.workflows) ? payload.workflows : [];
        const match = workflows.find(workflow => workflowTargetMatches(workflow, trimmed));
        return match?.id || null;
    }

    function formatObservationTimeoutOutput(rawOutput, timeoutMs) {
        const tail = String(rawOutput || '')
            .replace(/^Error:\s*Command timed out after \d+ms\s*/i, '')
            .trim();
        const body = tail || '(no output captured before timeout)';
        return limitTail(
            `Observation timeout after ${timeoutMs}ms for a likely long-running command. ` +
            `The process was stopped after collecting the output tail.\n${body}`
        );
    }

    function updateProjectIndex(filePath) {
        try {
            projectRegistry.projectForPath(filePath)?.retriever.updateFile(filePath);
        } catch { /* best effort */ }
        _readOnlyCacheGeneration++;
    }

    function readTextIfExists(filePath) {
        try {
            if (!fs.existsSync(filePath)) return '';
            return fs.readFileSync(filePath, 'utf-8');
        } catch {
            return '';
        }
    }

    function stable(value) {
        if (Array.isArray(value)) return value.map(stable);
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value)
                    .filter(([, v]) => v !== undefined)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => [k, stable(v)]),
            );
        }
        return value;
    }

    function clonePlain(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function fileFingerprint(filePath) {
        try {
            const stat = fs.statSync(filePath);
            return {
                filePath,
                size: stat.size,
                mtimeMs: Math.round(stat.mtimeMs),
            };
        } catch {
            return { filePath, missing: true };
        }
    }

    function cacheKey(kind, args, fingerprint) {
        return JSON.stringify(stable({
            kind,
            args,
            fingerprint,
            generation: _readOnlyCacheGeneration,
        }));
    }

    function compactCachedResult(kind, cached) {
        const result = clonePlain(cached.result);
        const output = String(result.output || result.content || result.message || '').trim();
        const excerpt = output.length > 1200 ? `${output.slice(0, 1200)}\n[... cached output truncated ...]` : output;
        result.output = `[Bahulam Code reused prior ${kind} result; source unchanged.]${excerpt ? `\n\n${excerpt}` : ''}`;
        if (typeof result.content === 'string') {
            result.content = result.content.length > 1200
                ? `${result.content.slice(0, 1200)}\n[... cached content truncated ...]`
                : result.content;
        }
        result._cache_reused = true;
        result._cache_source_call = cached.callId;
        return result;
    }

    async function withReadOnlyCache(kind, args, fingerprint, compute) {
        const key = cacheKey(kind, args, fingerprint);
        const cached = readOnlyResultCache.get(key);
        if (cached) return compactCachedResult(kind, cached);
        const result = await compute();
        if (result?.success !== false) {
            readOnlyResultCache.set(key, {
                result: clonePlain(result),
                callId: `${kind}-${readOnlyResultCache.size + 1}`,
            });
        }
        return result;
    }

    function buildResultFileDiff(filePath, before, after) {
        const diff = buildFileDiff({
            filePath,
            before,
            after,
            cwd: projectRootFor(filePath),
        });
        if (!isSensitiveConfigPath(filePath)) return diff;
        return {
            ...diff,
            hunks: [],
            unified: '',
            redacted: true,
            sensitive: true,
            redaction_reason: 'Sensitive config diff redacted',
        };
    }

    function attachFileDiff(result, filePath, before, after) {
        try {
            const diff = buildResultFileDiff(filePath, before, after);
            result.file_diff = diff;
            result.diff = diff.unified;
            result.lines_added = diff.lines_added;
            result.lines_removed = diff.lines_removed;
            if (diff.redacted) {
                result.output = `File updated: ${diff.relative_path || filePath}\nDiff redacted for sensitive config file.`;
                result.redacted = true;
            }
        } catch { /* best effort */ }
        return result;
    }

    /**
     * Detect if an OCC tool result string indicates an error.
     */
    function isError(result) {
        if (typeof result !== 'string') return false;
        return result.startsWith('Error:') || result.startsWith('Error -') ||
               result.includes('Exit code:') && !result.includes('Exit code: 0');
    }

    /**
     * Wrap an OCC string result into Bahulam's { success, output } format.
     */
    function wrapResult(result, toolName) {
        if (typeof result === 'object' && result !== null && 'success' in result) {
            result._tool = toolName;
            return result;
        }
        const output = typeof result === 'string' ? result : JSON.stringify(result);
        return {
            success: !isError(output),
            output,
            _tool: toolName,
        };
    }

    // ── Auto-lint after file writes ────────────────────────────

    // tsc --pretty and eslint emit ANSI codes (including background-red
    // highlights) which bleed when our renderer slices the first 80 chars.
    // Strip color codes so the stored lint string is always plain text.
    const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
    function stripAnsi(s) { return String(s || '').replace(ANSI_RE, ''); }

    function runAutoLintCommand(lint) {
        return new Promise((resolve) => {
            exec(lint.command, {
                encoding: 'utf-8',
                timeout: 15_000,
                cwd: lint.cwd,
                maxBuffer: 1_000_000,
                env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
            }, (err, stdout = '', stderr = '') => {
                const output = err
                    ? stripAnsi(stderr || stdout || '').trim()
                    : stripAnsi(stdout || stderr || '').trim();
                resolve(output || null);
            });
        });
    }

    async function autoLint(filePath) {
        const project = projectRegistry.projectForPath(filePath);
        const lint = resolveLintCommand(filePath, {
            projectRoot: project?.resource?.root || projectRootFor(filePath),
            projectCommands: project?.resource?.commands || {},
            allowProjectScript: false,
        });
        if (!lint?.command) return null;

        return runAutoLintCommand(lint);
    }

    // ── Post-edit verification hint ──────────────────────────────
    // Appended to edit_file/write_file results so the model knows
    // exactly how to verify. Uses detected project commands.

    function verificationHint(filePath) {
        const project = projectRegistry.projectForPath(filePath);
        const commands = project?.resource?.commands || {};
        const parts = [];
        if (commands.test) {
            parts.push(`Run tests: ${commands.test}`);
        }
        if (parts.length === 0) {
            const ext = path.extname(filePath);
            if (ext === '.py') parts.push('Run tests: python -m pytest');
            else if (['.js', '.ts', '.tsx', '.mjs'].includes(ext)) parts.push('Run tests: npm test');
        }
        return parts.length ? `\n--- Verify ---\n${parts.join('\n')}` : '';
    }

    // ── Solution nudge after exploration ───────────────────────
    // After the agent has read enough code, nudge it to formulate
    // a solution based on the goal — not to blindly edit, but to
    // synthesize what it learned into a fix approach.
    let _codeReadsCount = 0;
    let _hasEdited = false;

    function solutionNudge(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const isCode = ['.py', '.js', '.ts', '.tsx', '.mjs', '.go', '.rs', '.java', '.rb'].includes(ext);
        if (!isCode || _hasEdited) return '';

        _codeReadsCount++;
        if (_codeReadsCount < 4) return '';

        // Only nudge once at threshold, not every read after
        if (_codeReadsCount === 4) {
            return '\n\n--- You have explored enough code to formulate a solution. ' +
                'Based on what you have read, determine the fix and apply it. ' +
                'If the approach is unclear, call plan() with your findings. ---';
        }
        return '';
    }

    function buildDirectoryTree(rootPath, { maxDepth = 2, maxEntries = 200 } = {}) {
        const ignored = new Set(['.git', 'node_modules', '.next', '.turbo', 'dist', 'build', 'coverage']);
        const rootName = path.basename(rootPath) || rootPath;
        const lines = [`${rootName}/`];
        const files = [];
        const directories = [rootPath];
        let entriesSeen = 0;
        let truncated = false;

        function walk(dir, depth, prefix) {
            if (depth >= maxDepth || truncated) return;
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true })
                    .filter(entry => !ignored.has(entry.name))
                    .sort((a, b) => {
                        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
                        return a.name.localeCompare(b.name);
                    });
            } catch (err) {
                lines.push(`${prefix}[error: ${err.message}]`);
                return;
            }

            for (let i = 0; i < entries.length; i++) {
                if (entriesSeen >= maxEntries) {
                    truncated = true;
                    lines.push(`${prefix}... [truncated after ${maxEntries} entries]`);
                    return;
                }
                const entry = entries[i];
                const fullPath = path.join(dir, entry.name);
                const isLast = i === entries.length - 1;
                const connector = isLast ? '`-- ' : '|-- ';
                entriesSeen++;

                if (entry.isDirectory()) {
                    directories.push(fullPath);
                    lines.push(`${prefix}${connector}${entry.name}/`);
                    walk(fullPath, depth + 1, `${prefix}${isLast ? '    ' : '|   '}`);
                } else {
                    files.push(fullPath);
                    lines.push(`${prefix}${connector}${entry.name}`);
                }
            }
        }

        walk(rootPath, 0, '');
        return { output: lines.join('\n'), files, directories, truncated };
    }

    // ── Plugin tool map ──────────────────────────────────────────
    // Plugin tools are registered here alongside the built-in toolMap.
    // They are dispatched with lower priority (built-in tools win on name collision).
    const pluginToolMap = new Map(); // name → async handler function

    function registerPluginTool(name, handler, metadata = {}) {
        if (pluginToolMap.has(name)) {
            if (process.env.DEBUG) {
                console.warn(`Plugin tool "${name}" already registered from another plugin — skipping.`);
            }
            return false;
        }
        handler._pluginTool = metadata;
        pluginToolMap.set(name, handler);
        return true;
    }

    // Per-plugin state handles are opened lazily on first tool call and
    // cached process-wide. `makePluginState` itself dedupes on plugin
    // name, so this Map only exists to avoid re-attaching stateEmit on
    // every registered tool.
    const _pluginStateHandles = new Map(); // pluginName -> state proxy
    async function _pluginStateFor(pluginName) {
        if (!pluginName) return null;
        if (_pluginStateHandles.has(pluginName)) return _pluginStateHandles.get(pluginName);
        const { makePluginState } = await import('../plugins/state.mjs');
        const state = makePluginState(pluginName, { emit: stateEmit });
        _pluginStateHandles.set(pluginName, state);
        return state;
    }

    /**
     * Register one MCP tool under `<serverName>.<toolName>` (namespaced
     * to prevent collisions between plugins that ship servers with the
     * same tool name). The MCP client is owned by the caller (agent-
     * relay) which spawns/tears it down with the workspace lifetime.
     * Handler receives the same options shape as JS plugin tools so
     * `state`, `signal`, `pluginName` all work uniformly.
     */
    function registerMcpTool(pluginName, serverName, toolName, mcpClient, toolSchema = {}) {
        const qualified = `${serverName}.${toolName}`;
        if (toolMap[qualified] || pluginToolMap.has(qualified)) {
            if (process.env.DEBUG) {
                console.warn(`MCP tool "${qualified}" from plugin "${pluginName}" collides with an existing tool — skipping.`);
            }
            return false;
        }
        const mcpHandler = async (args, options = {}) => {
            // The lazy-state getter matches JS plugin tools so an MCP
            // "wrapper" tool can trivially write its result to the same
            // Shared Blackboard (rare, but useful for cache-and-return).
            const handlerOpts = {
                ...options,
                pluginName,
                mcpServer: serverName,
                get state() {
                    if (this._stateP) return this._stateP;
                    this._stateP = _pluginStateFor(pluginName);
                    return this._stateP;
                },
            };
            try {
                const result = await mcpClient.callTool(toolName, args || {});
                // callTool returns joined text for text/* content; pass through as output.
                const output = typeof result === 'string' ? result : (result?.output ?? result);
                // Allow the caller (state-writer wrapper) to introspect via handlerOpts.
                void handlerOpts;
                return { success: true, output, _tool: qualified, _plugin: pluginName, _mcp_server: serverName };
            } catch (err) {
                return {
                    success: false,
                    output: `MCP tool error (${qualified}): ${err.message}`,
                    _tool: qualified,
                    _plugin: pluginName,
                    _mcp_server: serverName,
                };
            }
        };
        mcpHandler._pluginTool = { pluginName, source: 'mcp', serverName, toolName };
        pluginToolMap.set(qualified, mcpHandler);
        // Track schema for tool-listing surfaces (also help /tools discovery).
        pluginToolMap.get(qualified)._mcp = { pluginName, serverName, toolName, schema: toolSchema };
        return true;
    }

    function registerPluginToolsFromRegistry() {
        if (!pluginRegistry) return;
        for (const toolDef of pluginRegistry.listTools?.() || []) {
            const name = String(toolDef.name || '').trim();
            if (!name || toolMap[name]) continue;
            const pluginName = toolDef._plugin_name || toolDef.plugin_name || null;
            if (toolDef._composed?.kind === 'pi') {
                // Composed pi tools resolve at invocation time: look up the
                // installed pi package's directory, load the specific handler
                // via the shim-backed probe, invoke, return the result. Handler
                // cache is per-session (per tool name) to amortize the ~50ms
                // child-process overhead on repeat calls.
                let _piInvokeP = null;
                registerPluginTool(name, async (args, options = {}) => {
                    try {
                        if (!_piInvokeP) {
                            const { loadPiToolHandler } = await import('../plugins/pi-compat/probe.mjs');
                            const packageName = toolDef._composed.package_name;
                            const originalName = toolDef._composed.original_name;
                            const { bahulamHome } = await import('./paths.mjs');
                            const piBaseDir = path.join(bahulamHome(), 'plugins-pi');
                            const piDir = path.join(piBaseDir, packageName.replace(/[/@]/g, '_'));
                            if (!fs.existsSync(piDir)) {
                                return {
                                    success: false,
                                    output: `Composed pi tool '${name}' unavailable: pi package ${packageName} is not installed. Run \`bahulam plugin install pi:${packageName}\`.`,
                                    _tool: name,
                                    _plugin: pluginName,
                                    _composed: toolDef._composed,
                                };
                            }
                            _piInvokeP = loadPiToolHandler(piDir, originalName, { pluginName: packageName });
                        }
                        const invoke = await _piInvokeP;
                        const result = await invoke(args || {});
                        return {
                            ...(result && typeof result === 'object' ? result : { success: true, output: String(result) }),
                            _tool: name,
                            _plugin: pluginName,
                            _composed: toolDef._composed,
                        };
                    } catch (err) {
                        return {
                            success: false,
                            output: `Composed pi tool '${name}' failed: ${err.message}`,
                            _tool: name,
                            _plugin: pluginName,
                            _composed: toolDef._composed,
                        };
                    }
                }, { pluginName, source: 'pi', composed: toolDef._composed });
                continue;
            }
            registerPluginTool(name, async (args, options = {}) => {
                const handler = await loadPluginTool(toolDef._plugin_dir, toolDef.tool);
                if (!handler) {
                    return {
                        success: false,
                        output: `Plugin tool module could not be loaded: ${name}`,
                        _tool: name,
                        _plugin: pluginName,
                    };
                }
                // Shared-blackboard injection: handlers opt in by naming
                // `state` in their signature (`async call(args, { state })`).
                // The property is a getter so the SQLite file is only
                // opened when a handler actually asks for it — plugins
                // that never touch state pay zero disk / init cost.
                const handlerOpts = {
                    ...options,
                    pluginName,
                    get state() { /* eslint-disable no-unused-vars */
                        // Sync getter fronting an async loader — first
                        // access returns a Promise, which is unusual
                        // for handler code but common enough as
                        // `const s = await opts.state`. The awaited
                        // value is cached on this options object so
                        // repeat accesses in the same call don't re-await.
                        if (this._stateP) return this._stateP;
                        this._stateP = _pluginStateFor(pluginName);
                        return this._stateP;
                    },
                };
                try {
                    const result = await handler.call(args || {}, handlerOpts);
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
            }, { pluginName, source: 'plugin' });
        }
    }

    function pluginAgentForTool(toolName, pluginName) {
        if (!pluginRegistry) return null;
        return (pluginRegistry.listAgents?.() || []).find(agent => {
            const agentPlugin = agent._plugin_name
                || String(agent.source || '').replace(/^plugin:/, '')
                || null;
            if (pluginName && agentPlugin && agentPlugin !== pluginName) return false;
            return Array.isArray(agent.tools) && agent.tools.includes(toolName);
        }) || null;
    }

    function primaryModelPluginToolBlock(name, handler, options = {}) {
        if (!handler?._pluginTool) return null;
        if (options.toolCallSource !== 'model') return null;
        if (options.internal || options.subAgent || options.allowPrimaryPluginToolCall) return null;

        const pluginName = handler._pluginTool.pluginName || 'plugin';
        // Tools-only plugins have no delegation owner: with no agent to
        // route through, the primary agent uses the tools directly (the
        // user consented by enabling the plugin). The delegate-only rule
        // applies only when the plugin ships an owning agent.
        const pluginShipsAgents = (pluginRegistry?.listAgents?.() || [])
            .some(agent => (agent._plugin_name || '') === pluginName);
        if (!pluginShipsAgents) return null;

        const agent = pluginAgentForTool(name, pluginName);
        const delegateHint = agent?.slug
            ? `Delegate to the '${agent.slug}' sub-agent instead, or run it explicitly with /run ${agent.slug} "...".`
            : `Delegate to the plugin's sub-agent instead, or run the plugin agent explicitly.`;
        return {
            success: false,
            output: `Plugin tool '${name}' is scoped to plugin '${pluginName}' and should not be called directly by the primary agent. ${delegateHint}`,
            _tool: name,
            _plugin: pluginName,
            _blocked: true,
            _requires_agent_delegation: true,
            _agent: agent?.slug || null,
        };
    }

    async function executeToolWithHooks(name, args, options = {}) {
        const handler = toolMap[name] || pluginToolMap.get(name);
        if (!handler) {
            return { success: false, output: `Unknown tool: ${name}`, _tool: name };
        }
        const pluginToolBlock = primaryModelPluginToolBlock(name, handler, options);
        if (pluginToolBlock) return pluginToolBlock;
        const hooks = hookRunner || new HookRunner({ cwd: process.cwd() });
        try {
            throwIfAborted(options.signal);
            const pre = await hooks.run('PreToolUse', { toolName: name, input: args || {} });
            throwIfAborted(options.signal);
            if (pre.blocked) {
                return { success: false, output: `BLOCKED by hook: ${pre.message}`, _tool: name, _blocked: true };
            }
            let result = await handler(args || {}, options);
            if (result?._cancelled) return result;
            throwIfAborted(options.signal);
            const post = await hooks.run('PostToolUse', { toolName: name, input: args || {}, result });
            throwIfAborted(options.signal);
            for (const item of post.results || []) {
                if (item.parsed?.modifiedResult !== undefined) result = item.parsed.modifiedResult;
                if (item.parsed?.feedback && result && typeof result === 'object') {
                    result.output = `${result.output || ''}\n\n--- Hook Feedback ---\n${item.parsed.feedback}`.trim();
                }
            }
            return result;
        } catch (err) {
            if (isAbortError(err) || options.signal?.aborted) {
                return cancelledToolResult(name);
            }
            return { success: false, output: `Tool error (${name}): ${err.message}`, _tool: name };
        }
    }

    // ── Tool mapping table ──────────────────────────────────────

    const toolMap = {
        // 0. ask_user → interactive direction question (client-executed).
        // The UI form is injected by the REPL via `interactionHandler`;
        // headless/piped sessions have none and get the best-judgment
        // fallback so the agent is never blocked on a missing human.
        ask_user: async (args, options = {}) => {
            throwIfAborted(options.signal);
            const question = String(args?.question || '').trim();
            const choices = Array.isArray(args?.options)
                ? args.options.map(o => String(o || '').trim()).filter(Boolean)
                : [];
            if (!question) {
                return { success: false, output: 'ask_user requires a question.', _tool: 'ask_user' };
            }
            if (choices.length < 2 || choices.length > 4) {
                return { success: false, output: 'ask_user requires 2-4 options.', _tool: 'ask_user' };
            }
            if (!interactionHandler || !process.stdin.isTTY) {
                return {
                    success: true,
                    output: 'No interactive user is available in this session. Proceed with your best judgment and state the assumption you made.',
                    _tool: 'ask_user',
                };
            }
            const res = await interactionHandler({ question, options: choices, context: args?.context });
            throwIfAborted(options.signal);
            if (!res || !res.answer) {
                return {
                    success: true,
                    output: 'The user declined to answer. Proceed with your best judgment and state the assumption you made.',
                    _tool: 'ask_user',
                };
            }
            return {
                success: true,
                output: `User answered: ${res.answer}${res.source === 'free_text' ? ' (typed answer, not one of the offered options)' : ''}`,
                _tool: 'ask_user',
            };
        },

        // Reserved meta-tool adapter. Cloud backends may implement Delegate
        // natively; local callbacks use this to route through the exact same
        // registry + dispatch funnel as /run and workflows.
        delegate: async (args = {}, options = {}) => {
            throwIfAborted(options.signal);
            const target = String(args.agent || args.name || args.slug || args.sub_agent || '').trim();
            const instruction = String(args.instruction || args.task || args.prompt || args.request || '').trim();
            if (!target) {
                return { success: false, output: 'delegate requires an agent slug or name.', _tool: 'delegate' };
            }
            if (!instruction) {
                return { success: false, output: 'delegate requires an instruction.', _tool: 'delegate' };
            }
            const agent = agentRegistry.findAgent(target);
            if (!agent) {
                return {
                    success: false,
                    output: `Unknown delegate target '${target}'. Available agents: ${listRunnables().map(item => item.slug).join(', ') || '(none)'}`,
                    _tool: 'delegate',
                };
            }
            if (typeof activeDelegateRunner !== 'function') {
                return {
                    success: false,
                    output: 'Local delegate execution is not wired for this surface. Use /run <agent> "<task>" or delegate from a cloud execute session.',
                    _tool: 'delegate',
                    agent: compactAgentMetadata(agent),
                };
            }
            const delegated = await activeDelegateRunner({
                agent,
                slug: agent.slug,
                instruction,
                context: args.context && typeof args.context === 'object' ? args.context : {},
                options,
            });
            const payload = delegated?.result || delegated || {};
            const output = payload.output
                || payload.final_response
                || payload.result
                || (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
            return {
                success: delegated?.dispatched === false ? false : payload.success !== false,
                output: String(output || ''),
                agent: compactAgentMetadata(agent),
                run_id: payload.run_id || payload.graph_run_id || null,
                node_results: payload.node_results || undefined,
                _tool: 'delegate',
            };
        },

        analyze_image: async (args, options = {}) => {
            throwIfAborted(options.signal);
            const tool = occRegistry.get('analyze_image');
            if (!tool) {
                return { success: false, output: 'analyze_image tool is not registered in the CLI.', _tool: 'analyze_image' };
            }
            try {
                const result = await tool.call(args || {});
                throwIfAborted(options.signal);
                if (typeof result === 'string') {
                    return { success: !/^error\b/i.test(result), output: result, _tool: 'analyze_image' };
                }
                return {
                    success: result?.success !== false,
                    output: result?.output || result?.summary || JSON.stringify(result),
                    ...result,
                    _tool: 'analyze_image',
                };
            } catch (err) {
                return { success: false, output: String(err?.message || err), _tool: 'analyze_image' };
            }
        },

        generate_image: async (args, options = {}) => {
            throwIfAborted(options.signal);
            const tool = occRegistry.get('generate_image');
            if (!tool) {
                return { success: false, output: 'generate_image tool is not registered in the CLI.', _tool: 'generate_image' };
            }
            try {
                const result = await tool.call(args || {});
                throwIfAborted(options.signal);
                if (typeof result === 'string') {
                    return { success: !/^error\b/i.test(result), output: result, _tool: 'generate_image' };
                }
                return {
                    success: result?.success !== false,
                    output: result?.output || JSON.stringify(result),
                    ...result,
                    _tool: 'generate_image',
                };
            } catch (err) {
                return { success: false, output: String(err?.message || err), _tool: 'generate_image' };
            }
        },

        // 0b. read_attachment → chunked text extraction from a local document.
        // Backend registers the schema; execution happens client-side because
        // only the CLI has the user's filesystem. Supports the `path` mode
        // (local file); `upload_id` is chat-only and returns a redirect
        // error. Uses the shared prose-chunker so chunk boundaries and
        // page/chunk numbering match the server-side path executor byte-
        // for-byte (documents.py). Supports total_chunks metadata mode,
        // chunk_range/chunk_no selection, page filtering (PDFs), and
        // case-insensitive query substring filtering.
        read_attachment: async (args, options = {}) => {
            throwIfAborted(options.signal);
            const uploadId = String(args?.upload_id || '').trim();
            const rawPath = String(args?.path || '').trim();
            if (uploadId && !rawPath) {
                return {
                    success: false,
                    output: 'upload_id is a chat-only mode. In the CLI, pass path=<local path> to read a file the user has on disk.',
                    _tool: 'read_attachment',
                };
            }
            if (!rawPath) {
                return {
                    success: false,
                    output: 'read_attachment requires path=<local path> (upload_id is chat-only).',
                    _tool: 'read_attachment',
                };
            }
            // Route through projectRegistry.resolvePath — the same helper
            // read_file/edit_file use. This handles shell-escape unescaping,
            // LLM-quoting normalization, and external-file registration for
            // paths outside registered project roots (attachments in
            // ~/Downloads, /tmp, etc. are legitimate).
            let abs;
            try {
                abs = await resolvePath(rawPath, args, { allowExternalFileRead: true });
            } catch (err) {
                return { success: false, output: String(err?.message || err), _tool: 'read_attachment' };
            }

            const imageInfo = detectImageFile(abs);
            if (imageInfo) {
                return {
                    success: false,
                    output: `This file is an image (${imageInfo.mime_type}). read_attachment only extracts text documents. Use analyze_image with a specific question. If analyze_image already failed, report that vision error directly instead of retrying this image with read_attachment.`,
                    _tool: 'read_attachment',
                    _path: abs,
                    _mime: imageInfo.mime_type,
                };
            }

            const { extractFromPath } = await import('../context/prose-chunker.mjs');
            let mime, chunks;
            try {
                ({ mime, chunks } = await extractFromPath(abs));
            } catch (err) {
                return { success: false, output: `Failed to read ${abs}: ${err?.message || err}`, _tool: 'read_attachment' };
            }
            if (!mime) {
                return { success: false, output: `File not found or not a regular file: ${abs}`, _tool: 'read_attachment' };
            }
            if (!chunks.length) {
                return {
                    success: false,
                    output: `Unsupported or empty file (mime=${mime}). Supported text: pdf, txt, md/mdx, ipynb, csv, tsv, json, yaml, toml, xml, html, log, rst, sql, sh, .env, .ini, Dockerfile, .gitignore — plus any file whose first 8KB is valid UTF-8 (auto-sniffed). For CSV/Excel analysis use read_table; for images use analyze_image. If analyze_image already failed for this file, report that vision error directly instead of retrying with read_attachment.`,
                    _tool: 'read_attachment',
                };
            }

            // Ingest into the project's BM25 index so subsequent search_code
            // (and future search_document) calls surface this doc's chunks.
            // Best-effort: skip if the file isn't inside a registered project
            // (external attachment like ~/Downloads/foo.pdf), and never let
            // an index write fail the tool.
            try {
                const owningProject = projectRegistry.projectForPath(abs);
                if (owningProject?.retriever?.addProseChunks) {
                    const rel = path.relative(owningProject.resource.root, abs);
                    owningProject.retriever.addProseChunks(rel, chunks);
                }
            } catch { /* best-effort */ }

            const totalChunks = chunks.length;
            const totalPages = new Set(chunks.map(c => c.page).filter(p => p != null)).size;
            const totalChars = chunks.reduce((s, c) => s + c.text.length, 0);

            // total_chunks metadata mode — size-before-read for large docs.
            if (args?.total_chunks) {
                const previewLen = Math.min(400, chunks[0].text.length);
                const preview = chunks[0].text.slice(0, previewLen);
                const previewSuffix = previewLen < chunks[0].text.length ? '…' : '';
                const pagesLine = totalPages ? ` · ${totalPages} pages` : '';
                return {
                    success: true,
                    output: `📄 ${path.basename(abs)} · ${totalChars} chars · ${totalChunks} chunks (0-${totalChunks - 1})${pagesLine}\n\nFirst chunk preview:\n${preview}${previewSuffix}\n\nUse chunk_range='N-M' or chunk_no=N to read specific chunks.`,
                    _tool: 'read_attachment',
                    _path: abs,
                    _mime: mime,
                    _total_chunks: totalChunks,
                    _total_pages: totalPages,
                    _total_chars: totalChars,
                };
            }

            // chunk_range / chunk_no selection.
            let selected = chunks;
            const rangeStr = String(args?.chunk_range ?? '').trim()
                || (args?.chunk_no !== undefined && args?.chunk_no !== null
                    ? String(args.chunk_no).trim()
                    : '');
            if (rangeStr) {
                const m = rangeStr.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
                if (!m) {
                    return {
                        success: false,
                        output: `Invalid chunk_range: '${rangeStr}'. Use 'N' for a single chunk or 'N-M' for an inclusive range.`,
                        _tool: 'read_attachment',
                    };
                }
                const start = parseInt(m[1], 10);
                const end = m[2] != null ? parseInt(m[2], 10) : start;
                if (end < start) {
                    return {
                        success: false,
                        output: `Invalid chunk_range '${rangeStr}': end (${end}) is before start (${start}).`,
                        _tool: 'read_attachment',
                    };
                }
                selected = chunks.filter(c => c.chunk_no >= start && c.chunk_no <= end);
                if (!selected.length) {
                    return {
                        success: false,
                        output: `No chunks in range ${start}-${end}. Doc has ${totalChunks} chunks (0-${totalChunks - 1}).`,
                        _tool: 'read_attachment',
                    };
                }
            }

            // page filter (PDF only — no-op on text docs where page is null).
            if (args?.page !== undefined && args?.page !== null) {
                const p = parseInt(args.page, 10);
                if (Number.isFinite(p)) {
                    selected = selected.filter(c => c.page === p);
                    if (!selected.length) {
                        return {
                            success: false,
                            output: `No chunks on page ${p}. Doc has ${totalPages} pages.`,
                            _tool: 'read_attachment',
                        };
                    }
                }
            }

            // query substring filter (case-insensitive, per-chunk).
            const query = String(args?.query || '').trim();
            if (query) {
                const q = query.toLowerCase();
                selected = selected.filter(c => c.text.toLowerCase().includes(q));
                if (!selected.length) {
                    return {
                        success: true,
                        output: `(No chunks matched query="${query}".)`,
                        _tool: 'read_attachment',
                        _path: abs,
                        _total_chunks: totalChunks,
                        _returned_chunks: 0,
                    };
                }
            }

            // Render chunks — matches server _render_chunks format:
            // [page N, chunk M]\n<text>\n\n
            const maxChars = Math.max(1000, Number(args?.max_chars) || 100_000);
            const lines = [];
            let total = 0;
            let truncated = false;
            let renderedCount = 0;
            for (const c of selected) {
                const headerBits = [];
                if (c.page != null) headerBits.push(`page ${c.page}`);
                headerBits.push(`chunk ${c.chunk_no}`);
                const block = `[${headerBits.join(', ')}]\n${c.text}`;
                if (total + block.length + 2 > maxChars) {
                    lines.push(`... [truncated at chunk ${c.chunk_no} to fit max_chars=${maxChars}. Use chunk_range='${c.chunk_no}-${selected[selected.length - 1].chunk_no}' to read the rest.]`);
                    truncated = true;
                    break;
                }
                lines.push(block);
                total += block.length + 2;
                renderedCount += 1;
            }

            const pagesLine = totalPages ? ` · ${totalPages} pages` : '';
            const truncNote = truncated ? ' (truncated)' : '';
            const header = `📄 ${path.basename(abs)} · ${totalChunks} chunks total${pagesLine} · showing ${renderedCount}${truncNote}\n\n`;
            return {
                success: true,
                output: header + lines.join('\n\n'),
                _tool: 'read_attachment',
                _path: abs,
                _mime: mime,
                _total_chunks: totalChunks,
                _returned_chunks: renderedCount,
                _truncated: truncated,
            };
        },

        // 1. shell → Bash + classification + smart output filtering
        shell: async (args, options = {}) => {
            throwIfAborted(options.signal);
            // Phase 1: legacy safety check (kept for backward compat)
            const shellCheck = validateShellCommand(args.command);
            if (!shellCheck.safe) {
                return {
                    success: false,
                    output: blockedShellOutput(shellCheck.reason),
                    _tool: 'shell', _blocked: true,
                };
            }

            // Phase 2: command classifier (PRD-050)
            const classification = classifyCommand(args.command);
            if (classification.classification === 'blocked') {
                return {
                    success: false,
                    output: blockedShellOutput(classification.reason),
                    _tool: 'shell', _blocked: true,
                };
            }

            // Tag for approval/sandbox routing
            if (classification.highRisk || shellCheck.highRisk) {
                args._highRisk = true;
                args._riskReason = classification.reason || shellCheck.reason;
            }
            args._classification = classification.classification; // 'safe' or 'contained'
            const cwd = await commandCwd(args);

            // Background execution: start via the BackgroundTasks registry
            // and return immediately. Safety checks above still apply;
            // results are retrieved with job_output / killed with job_kill.
            if (args.run_in_background) {
                const job = backgroundTasks.start({
                    command: args.command,
                    cwd,
                    timeoutMs: args.timeout ? Math.min(Number(args.timeout), 3_600_000) : undefined,
                    // Deterministic wake-on-finish: completion dispatches the
                    // named agent through the trigger funnel (chain-guarded).
                    on_complete: args.on_complete_agent ? {
                        target: `agent:${String(args.on_complete_agent).trim()}`,
                        instruction: args.on_complete_instruction || null,
                    } : null,
                });
                return {
                    success: true,
                    output: `Background job started: ${job.id} (pid ${job.pid}). `
                        + `Check progress with job_output {"job_id": "${job.id}"}; stop with job_kill.`,
                    job_id: job.id,
                    _tool: 'shell',
                };
            }

            // Pre-check: if command is rm/unlink, verify targets exist first
            const rmMatch = (args.command || '').match(/^rm\s+(?:-\w+\s+)*(.+)$/);
            if (rmMatch) {
                const targets = rmMatch[1].split(/\s+/).filter(t => !t.startsWith('-'));
                const missing = targets.filter(t => {
                    try { return !fs.existsSync(shellTargetPath(cwd, t)); } catch { return true; }
                });
                if (missing.length > 0 && missing.length === targets.length) {
                    return {
                        success: true,
                        output: `No action needed: ${missing.join(', ')} — file(s) do not exist. Do not retry.`,
                        exit_code: 0,
                        _tool: 'shell',
                        _skipped: true,
                    };
                }
            }

            const observationTimeout = args.timeout == null && isLikelyLongRunningCommand(args.command);
            const effectiveTimeout = observationTimeout ? longRunningObservationTimeoutMs() : args.timeout;
            const result = await occRegistry.call('shell', {
                command: args.command,
                timeout: effectiveTimeout,
                description: args.description || `Run: ${(args.command || '').slice(0, 50)}`,
                cwd,
                signal: options.signal,
            });
            const rawOutput = typeof result === 'string' ? result : String(result);
            const cancelled = /^Error:\s*Command cancelled by user/i.test(rawOutput);
            const timedOut = /^Error:\s*Command timed out after \d+ms/i.test(rawOutput);
            const exitMatch = rawOutput.match(/Exit code: (\d+)/);
            const exitCode = cancelled ? 130 : (timedOut ? 124 : (exitMatch ? parseInt(exitMatch[1]) : 0));
            // Semantic exit code: grep returns 1 for "no matches" (not an error)
            const success = cancelled ? false : (observationTimeout && timedOut ? true : (!timedOut && !isExitCodeError(args.command, exitCode)));

            // Apply smart filtering based on command type
            const filtered = observationTimeout && timedOut
                ? {
                    output: formatObservationTimeoutOutput(rawOutput, effectiveTimeout),
                    commandType: detectCommandType(args.command),
                    truncated: false,
                    originalLines: rawOutput.split('\n').length,
                    filteredLines: rawOutput.split('\n').length,
                }
                : filterOutput(rawOutput, args.command, success);
            const agentOutput = observationTimeout && timedOut ? filtered.output : rawOutput;

            return {
                success,
                output: agentOutput,
                output_preview: filtered.output,
                exit_code: exitCode,
                _tool: 'shell',
                _classification: args._classification,
                _commandType: filtered.commandType,
                _filtered: filtered.truncated || filtered.originalLines !== filtered.filteredLines,
                _timed_out: timedOut,
                _cancelled: cancelled,
                _observation_timeout: observationTimeout && timedOut,
                _observation_timeout_ms: observationTimeout && timedOut ? effectiveTimeout : undefined,
            };
        },

        // 2. read_file → Read (with smart truncation for large files)
        read_file: async (args) => {
            const filePath = await resolvePath(args.file_path || args.path, args, { allowExternalFileRead: true });
            const hasLineRange = args.start_line || args.end_line || args.offset || args.limit;
            const offset = args.start_line ? args.start_line - 1 : args.offset;
            const limit = (args.start_line && args.end_line)
                ? (args.end_line - args.start_line + 1)
                : args.limit;

            return await withReadOnlyCache(
                'read_file',
                { filePath, offset, limit },
                fileFingerprint(filePath),
                async () => {

                    // Nudge: if reading shallow overview files, remind agent to search deeper
                    const basename = path.basename(filePath).toLowerCase();
                    const isShallowFile = ['readme.md', 'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod'].includes(basename);
                    const nudge = isShallowFile && !_searchCodeUsed
                        ? '\n\nNOTE: You read a top-level overview file. Use search_code(query) to find actual implementations before drawing conclusions. READMEs and package.json do NOT show what features exist in the codebase.'
                        : '';

                    // If no line range specified, auto-truncate and return AST summary
                    if (!hasLineRange) {
                        try {
                            const content = fs.readFileSync(filePath, 'utf-8');
                            const lines = content.split('\n').length;

                            if (lines > 50) {
                                // File >50 lines: return AST summary with line numbers
                                // Model must use start_line/end_line to read specific sections
                                const analysis = analyzeCode(filePath);
                                const firstLines = content.split('\n').slice(0, 20).join('\n');
                                return {
                                    success: true,
                                    output: `${analysis.summary}\n\n` +
                                            `## First 20 lines\n${firstLines}${nudge}`,
                                    _tool: 'read_file',
                                    _truncated: true,
                                    _total_lines: lines,
                                };
                            }
                            // Small file (<50 lines): return full content
                        } catch { /* let Read handle the error */ }
                    }

                    const result = await occRegistry.call('read_file', {
                        file_path: filePath,
                        offset,
                        limit,
                    });
                    const output = typeof result === 'string' ? result : String(result);
                    const content = output.replace(/^\s*\d+[→\t]/gm, '');
                    const actNudge = solutionNudge(filePath);
                    // Set _total_lines so the tool-card display doesn't have
                    // to compute line counts from the display-side `output`
                    // (which contains nudges + line-number prefixes that
                    // throw off the count and can render as "0 lines" when
                    // downstream fallbacks miss the payload). Uses the
                    // same split-by-newline convention as the >50-line
                    // truncation branch above so both paths agree.
                    return {
                        success: !isError(output),
                        content,
                        output: output + nudge + actNudge,
                        _tool: 'read_file',
                        _output_type: 'file_content',
                        _total_lines: content ? content.split('\n').length : 0,
                    };
                },
            );
        },

        // 3. write_file → Write + auto-lint + safety check
        write_file: async (args) => {
            const rawPath = args.file_path || args.path;
            if (!rawPath || rawPath === 'file' || rawPath.length < 3) {
                return { success: false, output: `Error: Invalid file path "${rawPath || ''}". Register the project, then use an absolute path.`, _tool: 'write_file' };
            }
            const filePath = await resolvePath(rawPath, args, { allowMissing: true });
            const before = readTextIfExists(filePath);
            const writeCheck = validateWrite(filePath, args.content, projectRootFor(filePath));
            if (!writeCheck.safe) {
                return { success: false, output: `🛡️ BLOCKED: ${writeCheck.reason}`, _tool: 'write_file', _blocked: true };
            }
            // OCC Write requires Read first for existing files — handle gracefully
            try {
                if (fs.existsSync(filePath)) {
                    await occRegistry.call('read_file', { file_path: filePath, limit: 1 });
                }
            } catch { /* file may not exist yet */ }
            // Checkpoint before overwrite so /undo can restore the previous content.
            if (checkpoints && fs.existsSync(filePath)) {
                try { checkpoints.save(filePath); } catch { /* best effort */ }
            }
            const result = await occRegistry.call('write_file', {
                file_path: filePath,
                content: args.content,
            });
            const wrapped = wrapResult(result, 'write_file');
            const after = readTextIfExists(filePath);
            attachFileDiff(wrapped, filePath, before, after);
            updateProjectIndex(filePath);

            // Auto-lint the written file
            const lintOutput = await autoLint(filePath);
            if (lintOutput) {
                wrapped.output += `\n\n--- Lint ---\n${lintOutput}`;
                wrapped.lint = lintOutput;
            }

            // Nudge: tell the model how to verify
            const hint = verificationHint(filePath);
            if (hint) wrapped.output += hint;

            return wrapped;
        },

        // 3b. write_project → Batch write multiple files at once
        write_project: async (args) => {
            const files = args.files || [];
            if (!files.length) {
                return { success: false, output: 'Error: No files provided', _tool: 'write_project' };
            }

            const results = [];
            const errors = [];
            const diffs = [];

            for (const file of files) {
                const rawPath = file.path || file.file_path;
                if (!rawPath) {
                    errors.push('Missing path in file entry');
                    continue;
                }
                const filePath = await resolvePath(rawPath, file, { allowMissing: true });
                const content = file.content || '';

                const writeCheck = validateWrite(filePath, content, projectRootFor(filePath));
                if (!writeCheck.safe) {
                    errors.push(`${rawPath}: BLOCKED — ${writeCheck.reason}`);
                    continue;
                }

                try {
                    // Ensure parent directory exists
                    const dir = path.dirname(filePath);
                    fs.mkdirSync(dir, { recursive: true });
                    const before = readTextIfExists(filePath);

                    // Read first if exists (OCC Write requirement)
                    try {
                        if (fs.existsSync(filePath)) {
                            await occRegistry.call('read_file', { file_path: filePath, limit: 1 });
                        }
                    } catch { /* file may not exist yet */ }

                    await occRegistry.call('write_file', { file_path: filePath, content });
                    const after = readTextIfExists(filePath);
                    diffs.push(buildResultFileDiff(filePath, before, after));
                    updateProjectIndex(filePath);
                    results.push(rawPath);
                } catch (err) {
                    errors.push(`${rawPath}: ${err.message}`);
                }
            }

            const output = results.length > 0
                ? `Created ${results.length} file(s):\n${results.map(f => `  ✓ ${f}`).join('\n')}`
                : 'No files written';

            if (errors.length > 0) {
                return {
                    success: results.length > 0,
                    output: `${output}\n\nErrors:\n${errors.map(e => `  ✗ ${e}`).join('\n')}`,
                    files_written: results,
                    files_failed: errors,
                    file_diffs: diffs,
                    lines_added: diffs.reduce((sum, diff) => sum + (diff.lines_added || 0), 0),
                    lines_removed: diffs.reduce((sum, diff) => sum + (diff.lines_removed || 0), 0),
                    _tool: 'write_project',
                };
            }

            return {
                success: true,
                output,
                files_written: results,
                file_diffs: diffs,
                lines_added: diffs.reduce((sum, diff) => sum + (diff.lines_added || 0), 0),
                lines_removed: diffs.reduce((sum, diff) => sum + (diff.lines_removed || 0), 0),
                _tool: 'write_project',
            };
        },

        // 4. edit_file → Edit + auto-lint + auto-fallback to sed
        edit_file: async (args) => {
            const rawPath = args.file_path || args.path;
            const searchText = args.search ?? args.old_string ?? args.oldString;
            const replaceText = args.replace ?? args.new_string ?? args.newString;
            const replaceAll = args.replace_all === true || args.replaceAll === true;
            if (!rawPath || rawPath === 'file' || rawPath.length < 3) {
                return { success: false, output: `Error: Invalid file path "${rawPath || ''}". Register the project, then use an absolute path.`, _tool: 'edit_file' };
            }
            if (typeof searchText !== 'string' || searchText.length === 0) {
                return { success: false, output: 'Error: edit_file requires a non-empty search string.', _tool: 'edit_file' };
            }
            if (typeof replaceText !== 'string') {
                return { success: false, output: 'Error: edit_file requires a replacement string.', _tool: 'edit_file' };
            }
            const filePath = await resolvePath(rawPath, args);
            const before = readTextIfExists(filePath);
            const writeCheck = validateWrite(filePath, replaceText, projectRootFor(filePath));
            if (!writeCheck.safe) {
                return { success: false, output: `BLOCKED: ${writeCheck.reason}`, _tool: 'edit_file', _blocked: true };
            }
            // OCC Edit requires Read first
            try {
                await occRegistry.call('read_file', { file_path: filePath, limit: 1 });
            } catch { /* best effort */ }

            // Checkpoint before edit so /undo can restore the previous content.
            if (checkpoints) {
                try { checkpoints.save(filePath); } catch { /* best effort */ }
            }

            let result;
            try {
                result = await occRegistry.call('edit_file', {
                    file_path: filePath,
                    search: searchText,
                    replace: replaceText,
                    replace_all: replaceAll,
                });
            } catch (editErr) {
                // OCC Edit failed (string not found) — fallback to direct text replacement.
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    if (!content.includes(searchText)) {
                        throw new Error('search string not found in file');
                    }
                    const nextContent = replaceAll
                        ? content.split(searchText).join(replaceText)
                        : content.replace(searchText, replaceText);
                    if (nextContent !== content) {
                        fs.writeFileSync(filePath, nextContent, 'utf-8');
                    }
                    result = `Edited ${filePath} (via fallback): OK: replaced`;
                } catch (fallbackErr) {
                    return { success: false, output: `edit_file failed: ${editErr?.message || 'unknown'}. Fallback also failed: ${fallbackErr?.message || 'unknown'}. Re-read the target range and provide an exact search string.`, _tool: 'edit_file' };
                }
            }

            const wrapped = wrapResult(result, 'edit_file');
            const after = readTextIfExists(filePath);
            if (wrapped.success !== false && before === after) {
                const relativePath = path.relative(projectRootFor(filePath), filePath) || path.basename(filePath);
                // File content is unchanged — the desired state is already in place.
                // Return success so the agent doesn't treat this as a failure and
                // loop into repeated read_file calls trying to diagnose why it failed.
                // _no_change flags this for stagnation detection on repeated no-op edits.
                return {
                    success: true,
                    output: `edit_file: no changes made to ${relativePath} — content already matches or replacement is identical to the original.`,
                    _tool: 'edit_file',
                    _no_change: true,
                    no_change: true,
                    file_path: filePath,
                    relative_path: relativePath,
                    lines_added: 0,
                    lines_removed: 0,
                };
            }
            attachFileDiff(wrapped, filePath, before, after);
            updateProjectIndex(filePath);
            _hasEdited = true;

            // Auto-lint the edited file
            const lintOutput = await autoLint(filePath);
            if (lintOutput) {
                wrapped.output += `\n\n--- Lint ---\n${lintOutput}`;
                wrapped.lint = lintOutput;
            }

            // Nudge: tell the model how to verify
            const hint = verificationHint(filePath);
            if (hint) wrapped.output += hint;

            return wrapped;
        },

        // 5. list_files → Glob
        list_files: async (args) => {
            const searchPath = await resolvePath(args.path || null, args);
            return await withReadOnlyCache(
                'list_files',
                {
                    pattern: args.pattern || '**/*',
                    path: searchPath,
                    format: args.format || (args.tree === true ? 'tree' : 'glob'),
                    max_depth: args.max_depth ?? args.maxDepth ?? null,
                },
                { generation: _readOnlyCacheGeneration },
                async () => {
                    if (args.format === 'tree' || args.tree === true) {
                        const requestedDepth = Number(args.max_depth ?? args.maxDepth ?? 2);
                        const maxDepth = Number.isFinite(requestedDepth)
                            ? Math.max(1, Math.min(6, Math.trunc(requestedDepth)))
                            : 2;
                        const tree = buildDirectoryTree(searchPath, { maxDepth });
                        return {
                            success: true,
                            output: tree.output,
                            tree: tree.output,
                            files: tree.files,
                            directories: tree.directories,
                            truncated: tree.truncated,
                            _tool: 'list_files',
                            _format: 'tree',
                        };
                    }
                    const result = await occRegistry.call('list_files', {
                        pattern: args.pattern || '**/*',
                        path: searchPath,
                    });
                    const output = typeof result === 'string' ? result : String(result);
                    const files = output.split('\n').filter(Boolean);
                    return {
                        success: true,
                        files,
                        output,
                        _tool: 'list_files',
                    };
                },
            );
        },

        // 6. search_code → combined rg + BM25 for best results
        search_code: async (args) => {
            _searchCodeUsed = true;
            const query = args.query || args.pattern;
            if (!query) return { success: false, output: 'query required', _tool: 'search_code' };

            let project;
            if (args.project_id) {
                project = projectRegistry.get(args.project_id);
                if (!project) {
                    return { success: false, output: `Unknown project_id: ${args.project_id}`, _tool: 'search_code' };
                }
            } else if (args.path) {
                project = projectRegistry.projectForPath(await resolvePath(args.path, args));
            } else if (projectRegistry.resources().length === 1) {
                project = projectRegistry.get(projectRegistry.resources()[0].project_id);
            } else {
                return {
                    success: false,
                    output: 'search_code requires project_id when multiple or no projects are registered',
                    _tool: 'search_code',
                };
            }
            const searchPath = args.path ? await resolvePath(args.path, args) : project.resource.root;
            const parts = [];

            // Layer 1: ripgrep — exact text matches with context
            try {
                const cmd = `rg -n -C 1 --max-count 5 --max-filesize 500K -e ${JSON.stringify(query)} ${JSON.stringify(searchPath)} 2>/dev/null | head -60`;
                const rgOutput = execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd: searchPath }).trim();
                if (rgOutput) {
                    parts.push(`## Exact matches (rg)\n${rgOutput}`);
                }
            } catch { /* rg not found or no results */ }

            // Layer 2: Symbol search — AST-extracted functions/classes with signatures
            if (project?.retriever) {
                if (!project.retriever.index) project.retriever.loadIndex();
                const symbols = project.retriever.searchSymbols(query, 5);
                if (symbols.length > 0) {
                    const symOutput = project.retriever.formatSymbolResults(symbols);
                    parts.push(`## Symbols (functions/classes)\n${symOutput}`);
                }

                // Layer 3: BM25 chunks — broader context when symbols aren't enough
                const chunks = project.retriever.retrieve(query, 5);
                if (chunks.length > 0) {
                    const bm25Output = chunks.map(c => {
                        const score = c.score?.toFixed(2) || '?';
                        return `── ${c.id} (score: ${score}) ──\n${c.text}`;
                    }).join('\n\n');
                    parts.push(`## Related code (BM25)\n${bm25Output}`);
                }
            }

            // Return combined results
            if (parts.length > 0) {
                return {
                    success: true,
                    output: parts.join('\n\n'),
                    _tool: 'search_code',
                    _method: parts.length > 1 ? 'rg+bm25' : (parts[0].startsWith('## Exact') ? 'rg' : 'bm25'),
                };
            }

            // Nothing found — actionable hint
            const firstWord = query.split(/\s+/)[0];
            return {
                success: true,
                output: `No results for "${query}" in ${searchPath}.\n` +
                    `Try: shell(grep -rn "${firstWord}" . --include="*.py" | head -20)`,
                _tool: 'search_code',
                _method: 'none',
            };
        },

        // 7. search_files → Grep with line numbers + context (like grep -n -C 3)
        search_files: async (args) => {
            const query = args.query || args.pattern || '*';
            const searchPath = await resolvePath(args.path || null, args);

            // If it looks like a glob pattern, use Glob
            if (query.includes('*') || query.includes('?')) {
                return await withReadOnlyCache(
                    'search_files',
                    { query, path: searchPath, mode: 'glob' },
                    { generation: _readOnlyCacheGeneration },
                    async () => {
                        const result = await occRegistry.call('list_files', {
                            pattern: query,
                            path: searchPath,
                        });
                        const output = typeof result === 'string' ? result : String(result);
                        return {
                            success: true,
                            files: output.split('\n').filter(Boolean),
                            output,
                            _tool: 'search_files',
                        };
                    },
                );
            }

            // For text patterns: grep with context lines (like grep -n -C 3)
            return await withReadOnlyCache(
                'search_files',
                { query, path: searchPath, mode: 'grep' },
                { generation: _readOnlyCacheGeneration },
                async () => {
                    const result = await occRegistry.call('search_code', {
                        pattern: query,
                        path: searchPath,
                        output_mode: 'content',
                        '-n': true,
                        '-C': 3,
                        head_limit: 50,
                    });
                    const output = typeof result === 'string' ? result : String(result);
                    return {
                        success: true,
                        files: output.split('\n').filter(Boolean),
                        output,
                        _tool: 'search_files',
                    };
                },
            );
        },

        // 7b. grep → dedicated ripgrep tool (fast text/regex search)
        grep: async (args) => {
            const pattern = args.pattern;
            if (!pattern) return { success: false, output: 'pattern required', _tool: 'grep' };

            const searchPath = await resolvePath(args.path || null, args);
            const includeFlag = args.include ? `--glob "${args.include}"` : '';

            try {
                const cmd = `rg -n -C 2 --max-count 10 --max-filesize 500K ${includeFlag} -e ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -80`;
                const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd: searchPath }).trim();
                if (output) {
                    return { success: true, output, _tool: 'grep' };
                }
            } catch { /* no results or rg not found */ }

            return {
                success: true,
                output: `No matches for "${pattern}" in ${searchPath}`,
                _tool: 'grep',
            };
        },

        // ── Bahulam-specific tools (no OCC bridge) ──────────────

        // 8. read_files → batch Read (with AST truncation for large files)
        read_files: async (args) => {
            const rawItems = args.items || args.files || args.file_paths || args.paths || [];
            const items = (Array.isArray(rawItems) ? rawItems : [])
                .map(item => typeof item === 'string' ? { file_path: item } : item)
                .filter(Boolean);
            const results = [];
            for (const item of items) {
                const p = item.file_path || item.path;
                try {
                    const result = await toolMap.read_file({
                        ...args,
                        ...item,
                        file_path: p,
                    });
                    results.push({
                        path: p,
                        success: result.success !== false,
                        content: result.content,
                        output: result.output,
                        lines: result._total_lines,
                        cached: Boolean(result._cache_reused),
                        truncated: Boolean(result._truncated),
                    });
                } catch (err) {
                    results.push({ path: p, error: err.message, success: false });
                }
            }
            return {
                success: results.every(item => item.success !== false),
                files: results,
                output: results.map(item => {
                    const status = item.success === false ? 'ERROR' : item.cached ? 'CACHED' : 'OK';
                    return `## ${item.path} [${status}]\n${item.output || item.content || item.error || ''}`;
                }).join('\n\n'),
                _tool: 'read_files',
            };
        },

        read_batch: async (args) => {
            const result = await toolMap.read_files({
                ...args,
                items: args.items || args.files || args.file_paths || args.paths || [],
            });
            return { ...result, _tool: 'read_batch' };
        },

        // 9. delete_file + safety check + checkpoint for undo
        delete_file: async (args) => {
            try {
                const filePath = await resolvePath(args.file_path || args.path, args);
                const delCheck = validateDelete(filePath, projectRootFor(filePath));
                if (!delCheck.safe) {
                    return { success: false, output: `🛡️ BLOCKED: ${delCheck.reason}`, _tool: 'delete_file', _blocked: true };
                }
                if (checkpoints) {
                    try { checkpoints.save(filePath); } catch { /* best effort */ }
                }
                fs.unlinkSync(filePath);
                updateProjectIndex(filePath);
                return { success: true, message: `Deleted ${args.path}`, _tool: 'delete_file' };
            } catch (err) {
                return { success: false, output: `Error: ${err.message}`, _tool: 'delete_file' };
            }
        },

        // 10. get_file_info
        get_file_info: async (args) => {
            try {
                const filePath = await resolvePath(args.file_path || args.path, args);
                const stat = fs.statSync(filePath);
                return {
                    success: true,
                    size: stat.size,
                    mtime: stat.mtime.toISOString(),
                    type: stat.isDirectory() ? 'directory' : 'file',
                    mode: stat.mode.toString(8),
                    _tool: 'get_file_info',
                };
            } catch (err) {
                return { success: false, output: `Error: ${err.message}`, _tool: 'get_file_info' };
            }
        },

        // 11. validate_file (syntax check)
        validate_file: async (args) => {
            try {
                const filePath = await resolvePath(args.path, args);
                const ext = path.extname(filePath);
                let cmd;
                if (ext === '.py') cmd = `python3 -m py_compile "${filePath}"`;
                else if (ext === '.js' || ext === '.mjs') cmd = `node --check "${filePath}"`;
                else return { success: true, valid: true, message: 'No validator for this file type', _tool: 'validate_file' };

                execSync(cmd, { stdio: 'pipe', cwd: projectRootFor(filePath) });
                return { success: true, valid: true, _tool: 'validate_file' };
            } catch (err) {
                return { success: true, valid: false, errors: err.stderr?.toString() || err.message, _tool: 'validate_file' };
            }
        },

        // 12. validate_build
        validate_build: async (args, options = {}) => {
            try {
                throwIfAborted(options.signal);
                let cmd = args.command;
                const cwd = await commandCwd(args);
                if (!cmd) {
                    if (fs.existsSync(path.join(cwd, 'package.json'))) cmd = 'npm run build';
                    else if (fs.existsSync(path.join(cwd, 'Makefile'))) cmd = 'make';
                    else if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) cmd = 'cargo build';
                    else return { success: false, output: 'No build system detected', _tool: 'validate_build' };
                }
                const output = await occRegistry.call('shell', {
                    command: cmd,
                    timeout: Math.min(args.timeout || 120_000, 600_000),
                    description: `Validate build: ${cmd.slice(0, 80)}`,
                    cwd,
                    signal: options.signal,
                });
                const rawOutput = typeof output === 'string' ? output : String(output);
                if (/^Error:\s*Command cancelled by user/i.test(rawOutput)) {
                    return { success: false, output: 'Cancelled by user', exit_code: 130, _cancelled: true, _tool: 'validate_build' };
                }
                const exitMatch = rawOutput.match(/Exit code: (\d+)/);
                if (exitMatch || /^Error:\s*Command timed out/i.test(rawOutput)) {
                    return { success: false, output: rawOutput, exit_code: exitMatch ? Number(exitMatch[1]) : 124, _tool: 'validate_build' };
                }
                return { success: true, output: rawOutput, _tool: 'validate_build' };
            } catch (err) {
                if (isAbortError(err) || options.signal?.aborted) return cancelledToolResult('validate_build');
                return { success: false, output: err.stderr?.toString() || err.message, _tool: 'validate_build' };
            }
        },

        // 13. validate_structure
        validate_structure: async (args) => {
            const expected = args.expected || [];
            const missing = [];
            for (const f of expected) {
                if (!fs.existsSync(await resolvePath(f, args, { allowMissing: true }))) {
                    missing.push(f);
                }
            }
            return {
                success: missing.length === 0,
                missing,
                checked: expected.length,
                _tool: 'validate_structure',
            };
        },

        // 14. lint_check
        lint_check: async (args, options = {}) => {
            try {
                throwIfAborted(options.signal);
                const filePath = await resolvePath(args.file_path || args.path, args);
                const project = projectRegistry.projectForPath(filePath);
                const lint = resolveLintCommand(filePath, {
                    projectRoot: project?.resource?.root || projectRootFor(filePath),
                    projectCommands: project?.resource?.commands || {},
                    allowProjectScript: true,
                });
                if (!lint?.command) {
                    return {
                        success: true,
                        issues: [],
                        message: 'No project-aware linter for this path or file type',
                        _tool: 'lint_check',
                    };
                }

                const shellResult = await executeToolWithHooks('shell', {
                    command: lint.command,
                    timeout: 30_000,
                    description: `Lint: ${path.basename(filePath)} (${lint.source})`,
                    cwd: lint.cwd,
                }, options);
                const rawOutput = typeof shellResult?.output === 'string'
                    ? shellResult.output
                    : (typeof shellResult === 'string' ? shellResult : String(shellResult));
                if (/^Error:\s*Command cancelled by user/i.test(rawOutput)) {
                    return { success: false, output: 'Cancelled by user', _cancelled: true, _tool: 'lint_check' };
                }
                const normalizedOutput = rawOutput === '(no output)' ? '' : rawOutput;
                return {
                    success: true,
                    output: normalizedOutput || 'No lint issues found.',
                    command: lint.command,
                    cwd: lint.cwd,
                    language: lint.language,
                    lint_source: lint.source,
                    issues: normalizedOutput.split('\n').filter(Boolean),
                    _tool: 'lint_check',
                };
            } catch (err) {
                if (isAbortError(err) || options.signal?.aborted) return cancelledToolResult('lint_check');
                return { success: false, output: err.message, _tool: 'lint_check' };
            }
        },

        // 15. run_tests
        run_tests: async (args, options = {}) => {
            try {
                throwIfAborted(options.signal);
                const cmd = args.command || 'npm test';
                const cwd = await commandCwd(args);
                const output = await occRegistry.call('shell', {
                    command: cmd,
                    timeout: Math.min(args.timeout || 120_000, 600_000),
                    description: `Run tests: ${cmd.slice(0, 80)}`,
                    cwd,
                    signal: options.signal,
                });
                const rawOutput = typeof output === 'string' ? output : String(output);
                if (/^Error:\s*Command cancelled by user/i.test(rawOutput)) {
                    return { success: false, output: 'Cancelled by user', exit_code: 130, _cancelled: true, _tool: 'run_tests' };
                }
                const exitMatch = rawOutput.match(/Exit code: (\d+)/);
                const timedOut = /^Error:\s*Command timed out/i.test(rawOutput);
                return {
                    success: !exitMatch && !timedOut,
                    output: rawOutput.slice(-3000),
                    exit_code: exitMatch ? Number(exitMatch[1]) : (timedOut ? 124 : 0),
                    _tool: 'run_tests',
                };
            } catch (err) {
                if (isAbortError(err) || options.signal?.aborted) return cancelledToolResult('run_tests');
                const output = (err.stdout || '') + (err.stderr || '');
                return { success: false, output: output.slice(-3000), exit_code: err.status, _tool: 'run_tests' };
            }
        },

        // 16. git_diff
        git_diff: async (args) => {
            try {
                const filePath = args.file_path ? `-- "${args.file_path}"` : '';
                const cwd = await commandCwd(args);
                const output = execSync(`git diff ${filePath}`, {
                    stdio: 'pipe', timeout: 10_000, cwd, encoding: 'utf-8',
                }).toString();
                return { success: true, output: output.slice(-5000) || '(no changes)', _tool: 'git_diff' };
            } catch (err) {
                return { success: false, output: err.message, _tool: 'git_diff' };
            }
        },

        // 17. git_status
        git_status: async (args) => {
            try {
                const cwd = await commandCwd(args);
                const output = execSync('git status --short', {
                    stdio: 'pipe', timeout: 10_000, cwd, encoding: 'utf-8',
                }).toString();
                return { success: true, output: output || '(clean)', _tool: 'git_status' };
            } catch (err) {
                return { success: false, output: err.message, _tool: 'git_status' };
            }
        },

        // 18. analyze_code — AST-based structured code analysis
        // Returns function signatures, classes, imports instead of raw file contents
        // 10x more token-efficient than read_file
        analyze_code: async (args) => {
            const filePath = await resolvePath(args.file_path || args.path, args);
            let stat;
            try {
                stat = fs.statSync(filePath);
            } catch (err) {
                return { success: false, output: `Error: ${err.message}`, structure: {}, _tool: 'analyze_code' };
            }
            if (stat.isDirectory()) {
                return {
                    success: false,
                    output: `Error: analyze_code expects a file, but got directory: ${filePath}. Use list_files/search_code first, then pass a specific source file.`,
                    structure: {},
                    _tool: 'analyze_code',
                };
            }
            const result = analyzeCode(filePath, {
                startLine: args.start_line,
                endLine: args.end_line,
            });
            return {
                success: result.success,
                output: result.summary,
                structure: result.structure,
                _tool: 'analyze_code',
            };
        },

        // Project overview — on-demand index + skeleton
        get_project_overview: async (args) => {
            const projectPath = args.path || args.project_path;
            const result = await projectRegistry.register(projectPath, {
                forceRefresh: Boolean(args.force_refresh || args.forceRefresh),
            });
            return {
                success: true,
                output: result.output,
                project_resource: result.resource,
                already_registered: result.already_registered,
                refreshed: result.refreshed,
                _tool: 'get_project_overview',
            };
        },

        // Portable skills — metadata first, full content only on demand.
        skills_list: async (args) => ({
            success: true,
            output: JSON.stringify(skillsLoader.list({
                query: args.query || '',
                source: args.source || '',
                scope: args.scope || '',
            }), null, 2),
            skills: skillsLoader.list({
                query: args.query || '',
                source: args.source || '',
                scope: args.scope || '',
            }),
            _tool: 'skills_list',
        }),

        skill_view: async (args) => {
            const skill = skillsLoader.view(
                args.name,
                args.path || null,
                { sourceId: args.source_id || null },
            );
            return {
                success: true,
                output: JSON.stringify(skill, null, 2),
                skill,
                _tool: 'skill_view',
            };
        },

        skill_install: async (args) => {
            const result = installer.install(args.source, {
                scope: skillScope(args),
                force: Boolean(args.force),
            });
            const skills = reloadSkillCatalog();
            const payload = { ...result, skills };
            return {
                success: true,
                output: JSON.stringify(payload, null, 2),
                ...payload,
                _tool: 'skill_install',
            };
        },

        skill_update: async (args) => {
            const result = installer.update(args.name, { scope: skillScope(args) });
            const skills = reloadSkillCatalog();
            const payload = { ...result, skills };
            return {
                success: true,
                output: JSON.stringify(payload, null, 2),
                ...payload,
                _tool: 'skill_update',
            };
        },

        skill_remove: async (args) => {
            const result = installer.remove(args.name, { scope: skillScope(args) });
            const skills = reloadSkillCatalog();
            const payload = { ...result, skills };
            return {
                success: true,
                output: JSON.stringify(payload, null, 2),
                ...payload,
                _tool: 'skill_remove',
            };
        },

        // User-defined agents — metadata first, project YAML + backend sync on demand.
        job_output: async (args = {}) => {
            const jobId = String(args.job_id || '').trim();
            if (!jobId) {
                const jobs = backgroundTasks.list();
                return {
                    success: true,
                    output: jobs.length
                        ? JSON.stringify({ jobs }, null, 2)
                        : 'No background jobs in this session.',
                    jobs,
                    _tool: 'job_output',
                };
            }
            const job = args.block
                ? await backgroundTasks.wait(jobId)
                : backgroundTasks.describe(jobId);
            if (!job) return { success: false, output: `Unknown job: ${jobId}`, _tool: 'job_output' };
            const tailLines = Number(args.tail_lines) || 80;
            const tail = String(job.tail || '').split('\n').slice(-tailLines).join('\n');
            return {
                success: true,
                output: `${job.id} · ${job.status}`
                    + (job.exit_code != null ? ` (exit ${job.exit_code})` : '')
                    + ` · ${job.duration_s}s\n${tail}`,
                job: { ...job, tail: undefined },
                _tool: 'job_output',
            };
        },

        job_kill: async (args = {}) => {
            const job = backgroundTasks.kill(String(args.job_id || '').trim());
            if (!job) return { success: false, output: `Unknown job: ${args.job_id}`, _tool: 'job_kill' };
            return { success: true, output: `${job.id} → ${job.status}`, job, _tool: 'job_kill' };
        },

        agents_list: async (args = {}) => {
            const agents = filterLocalAgents(args).map(compactAgentMetadata);
            const payload = { agents, count: agents.length };
            if (agents.some(agent => agent.runnable === false)) {
                payload.note = 'Agents with runnable:false are workspace-scoped plugin agents; add their slug to settings plugins.agent_allowlist to invoke them from the main loop.';
            }
            return {
                success: true,
                output: JSON.stringify(payload, null, 2),
                ...payload,
                _tool: 'agents_list',
            };
        },

        agent_create: async (args = {}) => {
            if (!args.name || !String(args.name).trim()) {
                throw new Error('name is required');
            }
            const result = createAgentFile({
                cwd: process.cwd(),
                name: args.name,
                description: args.description || '',
                role: args.role || 'specialist',
                model: args.model || '',
                tools: normalizeAgentTools(args.tools),
                prompt: args.system_prompt || args.prompt || '',
                force: Boolean(args.force),
            });
            const created = listLocalAgents(process.cwd()).find(agent => agent.slug === result.slug);
            const payload = {
                ...result,
                agent: created
                    ? { ...compactAgentMetadata(created), spec: created.spec }
                    : null,
                next_actions: [
                    `Edit ${result.filePath}`,
                    `Run /run ${result.slug} "<task>" or delegate to it from chat immediately`,
                    `Optional: /agents sync ${result.slug} to publish it to the backend for account/cloud reuse`,
                ],
            };
            return {
                success: true,
                output: JSON.stringify(payload, null, 2),
                ...payload,
                _tool: 'agent_create',
            };
        },

        agent_sync: async (args = {}) => {
            const selected = selectAgentsForSync(args);
            if (!selected.length) {
                const target = args.name || args.slug || '';
                throw new Error(target ? `No local agent found: ${target}` : 'No local agents found in .bahulam/agents');
            }
            const creds = new BahulamAuth().loadCredentials();
            const result = await syncAgentsToBackend({
                backendUrl: creds.backendUrl,
                token: creds.token,
                agents: selected,
            });
            const payload = {
                ...result,
                agents: selected.map(compactAgentMetadata),
            };
            return {
                success: true,
                output: JSON.stringify(payload, null, 2),
                ...payload,
                _tool: 'agent_sync',
            };
        },

        workflow_list: async (args = {}) => {
            const local = filterLocalWorkflows(args).map(compactWorkflowMetadata);
            let backend = [];
            try {
                const creds = new BahulamAuth().loadCredentials();
                if (creds.backendUrl && creds.token) {
                    const resp = await fetch(`${creds.backendUrl}${WORKFLOW_SYNC_ENDPOINT}`, {
                        headers: {
                            Authorization: `Bearer ${creds.token}`,
                            Accept: 'application/json',
                        },
                    });
                    if (resp.ok) {
                        const payload = await resp.json().catch(() => ({}));
                        backend = Array.isArray(payload.workflows) ? payload.workflows : [];
                    }
                }
            } catch {
                // best effort
            }
            const payload = {
                local_workflows: local,
                backend_workflows: backend,
                count: local.length + backend.length,
            };
            return {
                success: true,
                output: JSON.stringify(payload, null, 2),
                ...payload,
                _tool: 'workflow_list',
            };
        },

        workflow_create_multi: async (args = {}) => {
            if (!args.name || !String(args.name).trim()) {
                throw new Error('name is required');
            }
            const result = createWorkflowFile({
                cwd: process.cwd(),
                name: args.name,
                description: args.description || '',
                pattern: args.pattern || args.orchestration_pattern || 'sequential',
                agents: args.agents || [],
                edges: args.edges || [],
                globalParams: args.global_params || args.globalParams || {},
                force: Boolean(args.force),
            });
            const workflow = listLocalWorkflows(process.cwd()).find(item => item.slug === result.slug);
            const payload = {
                ...result,
                workflow: workflow ? compactWorkflowMetadata(workflow) : null,
                next_actions: [
                    `Edit ${result.filePath}`,
                    `Run workflow sync for ${result.slug} when ready`,
                ],
            };
            return {
                success: true,
                output: JSON.stringify(payload, null, 2),
                ...payload,
                _tool: 'workflow_create_multi',
            };
        },

        workflow_sync_multi: async (args = {}) => {
            const selected = selectWorkflowsForSync(args);
            if (!selected.length) {
                const target = args.name || args.slug || '';
                throw new Error(target ? `No local workflow found: ${target}` : 'No local workflows found in .bahulam/workflows');
            }
            const creds = new BahulamAuth().loadCredentials();
            if (!creds.backendUrl || !creds.token) {
                throw new Error('Not logged in. Run bahulam login first.');
            }

            const headers = {
                Authorization: `Bearer ${creds.token}`,
                'Content-Type': 'application/json',
            };
            const listResp = await fetch(`${creds.backendUrl}${WORKFLOW_SYNC_ENDPOINT}`, {
                headers: { Authorization: `Bearer ${creds.token}`, Accept: 'application/json' },
            });
            const backendPayload = listResp.ok ? await listResp.json().catch(() => ({})) : {};
            const existing = Array.isArray(backendPayload.workflows) ? backendPayload.workflows : [];
            const existingByName = new Map(existing.map(item => [String(item.name || '').toLowerCase(), item]));

            const results = [];
            for (const workflow of selected) {
                const payload = {
                    name: workflow.name,
                    description: workflow.description || '',
                    graph: workflow.graph,
                    global_params: workflow.global_params || {},
                    orchestration_pattern: workflow.pattern || workflow.orchestration_pattern || 'sequential',
                    pattern: workflow.pattern || workflow.orchestration_pattern || 'sequential',
                };
                const existingWorkflow = existingByName.get(String(workflow.name || '').toLowerCase());
                const endpoint = existingWorkflow
                    ? `${creds.backendUrl}${WORKFLOW_SYNC_ENDPOINT}/${encodeURIComponent(existingWorkflow.id)}`
                    : `${creds.backendUrl}${WORKFLOW_SYNC_ENDPOINT}`;
                const method = existingWorkflow ? 'PATCH' : 'POST';
                const resp = await fetch(endpoint, {
                    method,
                    headers,
                    body: JSON.stringify(payload),
                });
                if (!resp.ok) {
                    let detail = '';
                    try {
                        const data = await resp.json();
                        detail = data.detail || data.error || JSON.stringify(data);
                    } catch {
                        detail = await resp.text().catch(() => '');
                    }
                    throw new Error(`Workflow sync failed (${resp.status})${detail ? `: ${detail}` : ''}`);
                }
                const data = await resp.json().catch(() => ({}));
                results.push({
                    workflow: compactWorkflowMetadata(workflow),
                    action: existingWorkflow ? 'updated' : 'created',
                    id: data?.workflow?.id || data?.id || existingWorkflow?.id || null,
                });
            }

            const payload = {
                workflows: results,
                created: results.filter(item => item.action === 'created').length,
                updated: results.filter(item => item.action === 'updated').length,
            };
            return {
                success: true,
                output: JSON.stringify(payload, null, 2),
                ...payload,
                _tool: 'workflow_sync_multi',
            };
        },

        workflow_run_multi: async (args = {}, options = {}) => {
            const target = String(args.workflow_id || args.workflowId || args.id || args.name || args.slug || '').trim();
            if (!target) {
                throw new Error('workflow_id is required');
            }
            const creds = new BahulamAuth().loadCredentials();
            if (!creds.backendUrl || !creds.token) {
                throw new Error('Not logged in. Run bahulam login first.');
            }

            const workflowId = await resolveWorkflowId(creds, target);
            if (!workflowId) {
                const localMatch = listLocalWorkflows(process.cwd()).find(workflow => workflowTargetMatches(workflow, target));
                if (localMatch) {
                    throw new Error(`Workflow '${target}' exists locally but is not synced yet. Run workflow_sync_multi before workflow_run_multi.`);
                }
                throw new Error(`Workflow not found: ${target}`);
            }

            const url = `${creds.backendUrl}/api/workflows/${encodeURIComponent(workflowId)}/run-multi`;
            const approvalAllowedTools = [
                'get_project_overview',
                'write_file',
                'write_project',
                'edit_file',
                'shell',
                'lint_check',
                'validate_build',
                'run_tests',
                'agents_list',
                'agent_create',
                'agent_sync',
                'workflow_list',
                'workflow_create_multi',
                'workflow_sync_multi',
                'workflow_run_multi',
            ];
            const instruction = args.instruction || '';
            const projectResources = projectRegistry.resources();
            const workflowScope = buildWorkScope({
                instruction,
                cwd: process.cwd(),
                projectResources,
            });
            const suppliedGlobalParams = args.global_params || args.globalParams || {};
            const globalParams = {
                instruction,
                cwd: process.cwd(),
                project_root: process.cwd(),
                project_resources: projectResources,
                work_scope: workflowScope,
                ...suppliedGlobalParams,
            };
            const body = {
                trigger_input: {
                    instruction,
                    cwd: process.cwd(),
                    project_root: process.cwd(),
                    work_scope: globalParams.work_scope,
                },
                global_params: globalParams,
                orchestration_pattern: args.pattern || args.orchestration_pattern || 'sequential',
                pattern: args.pattern || args.orchestration_pattern || 'sequential',
                // Multi-agent workflow runs are SSE-only today. Do not forward
                // a model-supplied "sync" mode into the backend 400 path.
                mode: 'stream',
                approval_scope: {
                    approved: true,
                    source: 'cli_hitl',
                    scope: 'workflow_run',
                    workflow_id: workflowId,
                    target,
                    allowed_tools: approvalAllowedTools,
                    allow_destructive: false,
                    reason: 'User approved workflow execution',
                },
            };

            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${creds.token}`,
                    Accept: 'text/event-stream',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: options.signal,
            });

            if (!resp.ok) {
                let detail = '';
                try {
                    const data = await resp.json();
                    detail = data.detail || data.error || JSON.stringify(data);
                } catch {
                    detail = await resp.text().catch(() => '');
                }
                throw new Error(`Workflow run failed (${resp.status})${detail ? `: ${detail}` : ''}`);
            }

            const events = [];
            let final = null;
            let nestedToolCalls = 0;
            let callbacksPosted = 0;
            const workflowTaskId = resp.headers.get('X-Task-ID') || resp.headers.get('X-Workflow-Run-ID');
            for await (const event of streamResponse(resp)) {
                events.push(event.type);
                if (event.type === 'tool_call' || event.type === 'tool_request') {
                    if (event.server_side || event.data?.server_side) continue;
                    const toolName = event.tool || event.name || event.data?.tool || event.data?.name;
                    const callId = event.call_id || event.id || event.data?.call_id || event.data?.id;
                    const toolArgs = event.args || event.input || event.data?.args || event.data?.input || {};
                    if (!workflowTaskId || !callId || !toolName) {
                        throw new Error(`Workflow tool call missing callback metadata: ${JSON.stringify(event).slice(0, 300)}`);
                    }
                    if (toolName === 'workflow_run_multi') {
                        const nestedResult = {
                            success: false,
                            output: 'Nested workflow_run_multi is not allowed inside a workflow run.',
                        };
                        await sendCallback(creds.backendUrl, creds.token, workflowTaskId, callId, nestedResult);
                        throw new Error(nestedResult.output);
                    }
                    nestedToolCalls++;
                    const result = await executeToolWithHooks(toolName, toolArgs, {
                        ...options,
                        workflowRun: true,
                        workflowId,
                        workflowTaskId,
                    });
                    const posted = await sendCallback(creds.backendUrl, creds.token, workflowTaskId, callId, result);
                    if (!posted) {
                        throw new Error(`Workflow tool callback failed for ${toolName}`);
                    }
                    callbacksPosted++;
                } else if (event.type === 'approval_required') {
                    const toolId = event.tool_id || event.id || event.data?.tool_id || event.data?.id;
                    const toolName = event.tool || event.data?.tool || 'tool';
                    if (workflowTaskId && toolId) {
                        await sendApprovalDecision(
                            creds.backendUrl,
                            creds.token,
                            workflowTaskId,
                            toolId,
                            'deny',
                            'once',
                            'Workflow run approval scope did not include this operation',
                        );
                    }
                    throw new Error(`Workflow requested additional approval for ${toolName}; the upfront workflow-run approval scope did not cover it.`);
                } else if (event.type === 'orchestration_complete') {
                    final = event;
                } else if (event.type === 'run_error') {
                    const detail = event.error || event.data?.error || event.message || 'Workflow run failed';
                    throw new Error(detail);
                }
            }

            const payload = {
                workflow_id: workflowId,
                target,
                pattern: body.pattern,
                run_id: final?.run_id || null,
                result: final?.result || final?.data?.result || '',
                total_tokens: final?.total_tokens || 0,
                total_cost: final?.total_cost || 0,
                duration_s: final?.duration_s || 0,
                agent_count: final?.agent_count || 0,
                events_seen: events.length,
                nested_tool_calls: nestedToolCalls,
                callbacks_posted: callbacksPosted,
            };

            return {
                success: true,
                output: JSON.stringify(payload, null, 2),
                ...payload,
                _tool: 'workflow_run_multi',
            };
        },
    };

    registerPluginToolsFromRegistry();

    return {
        /**
         * Execute a Bahulam tool by name.
         * @param {string} name - Bahulam tool name
         * @param {Object} args - Tool arguments
         * @returns {Promise<Object>} - { success, output, ... }
         */
        async execute(name, args, options = {}) {
            return executeToolWithHooks(name, args, options);
        },

        /** List all available tool names. */
        listTools() {
            return [...Object.keys(toolMap), ...pluginToolMap.keys()];
        },

        /**
         * Register one MCP-backed tool as `<serverName>.<toolName>`.
         * Called by the workspace lifecycle after spawning per-plugin
         * MCP clients. Returns true on success, false on name collision.
         */
        registerMcpTool(pluginName, serverName, toolName, mcpClient, toolSchema) {
            return registerMcpTool(pluginName, serverName, toolName, mcpClient, toolSchema);
        },

        /**
         * Unregister every MCP tool sourced from one server, called on
         * plugin teardown / workspace close so subsequent sessions don't
         * see stale `serverName.tool` entries.
         */
        unregisterMcpServer(pluginName, serverName) {
            let removed = 0;
            for (const [key, fn] of pluginToolMap) {
                const meta = fn?._mcp;
                if (meta && meta.pluginName === pluginName && meta.serverName === serverName) {
                    pluginToolMap.delete(key);
                    removed++;
                }
            }
            return removed;
        },

        getProjectResources() {
            return projectRegistry.resources();
        },

        waitForAutoRegister() {
            return autoRegisterPromise;
        },

        async registerProjectRoots(roots, { forceRefresh = false } = {}) {
            const results = [];
            const seen = new Set();
            for (const root of Array.isArray(roots) ? roots : []) {
                if (!root || seen.has(root)) continue;
                seen.add(root);
                try {
                    // CLI-startup roots are declared by the user (via cwd, flag,
                    // or preflight) and should not be second-guessed by the
                    // project-marker guard. That guard exists to stop the AGENT
                    // from calling get_project_overview on non-project paths.
                    const result = await projectRegistry.register(root, {
                        forceRefresh,
                        bypassProjectMarkers: true,
                    });
                    results.push({ success: true, root: result.resource.root, ...result });
                } catch (err) {
                    results.push({ success: false, root, error: err.message });
                }
            }
            return results;
        },

        listRunnables,

        findAgent(target) {
            return agentRegistry.findAgent(target);
        },

        filterAgents(args = {}) {
            return agentRegistry.filterAgents(args);
        },

        getSubAgentObservability() {
            return agentRegistry.observability();
        },

        setDelegateRunner(fn) {
            activeDelegateRunner = typeof fn === 'function' ? fn : null;
        },

        // Plugin tool schemas (name/description/input_schema) for callers
        // that compose model-facing tool lists — e.g. the graph engine's
        // direct substrate giving a plugin agent its declared tools.
        listPluginToolSchemas() {
            if (!pluginRegistry) return [];
            return (pluginRegistry.listTools?.() || []).map(tool => ({
                name: tool.name,
                description: tool.description || '',
                input_schema: tool.input_schema || { type: 'object', properties: {} },
                plugin_name: tool._plugin_name || tool.plugin_name || null,
            })).filter(tool => tool.name);
        },

        getAgentContext() {
            const global = projectRegistry.getGlobalContext();
            const mem = _readMemorySnapshot();
            return {
                identity: global.identity,
                preferences: global.preferences,
                global_skills: skillsLoader.list(),
                // Cross-session memory read from disk (CLI-only source of truth).
                // Backend prefers this over the Supabase agent_memory table when
                // ctx.agent_ctx.source === 'cli'. `memory_digest` is a stable
                // sha256 prefix so the backend can hash-compare without
                // re-serializing — helps keep the prompt cacheable when memory
                // hasn't changed between turns.
                memory_facts: mem.facts,
                memory_digest: mem.digest,
                available_agents: listAvailableAgents().map(agent => ({
                    slug: agent.slug,
                    name: agent.name,
                    description: agent.description,
                    role: agent.role,
                    model: agent.model,
                    models: agent.models,
                    tools: agent.tools,
                    capabilities: agent.capabilities,
                    domains: agent.domains,
                    source_scope: agent.source_scope,
                    source: agent.source,
                    spec: agent.spec,
                })),
                sub_agent_observability: agentRegistry.observability(),
                // Background jobs the model should know about. Stable fields
                // only (no durations) so the entry — and the prompt cache —
                // changes on status transitions, not every turn.
                ...(backgroundTasks.list().length ? {
                    background_jobs: backgroundTasks.list().map(job => ({
                        id: job.id,
                        name: job.name,
                        status: job.status,
                        exit_code: job.exit_code,
                    })),
                } : {}),
                available_workflows: listLocalWorkflows(process.cwd()).map(workflow => ({
                    slug: workflow.slug,
                    name: workflow.name,
                    description: workflow.description || '',
                    pattern: workflow.pattern || workflow.orchestration_pattern || 'sequential',
                    agent_count: workflow.agent_count || 0,
                    edge_count: workflow.edge_count || 0,
                    source_scope: 'project',
                })),
                source: 'cli',
            };
        },

        reloadSkills(cwd = process.cwd()) {
            skillsLoader.load(cwd);
            return skillsLoader.list();
        },

        resetProjects() {
            projectRegistry.reset();
        },
    };
}
