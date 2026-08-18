/**
 * Tool Executor Bridge — maps Tarang backend tool names to OCC tool calls.
 *
 * The Tarang backend sends tool_request events with its own tool names and arg shapes.
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
import { createWorkflowFile, listLocalWorkflows, WORKFLOW_SYNC_ENDPOINT, slugifyWorkflowName } from '../agents/workflow_scaffold.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { streamResponse } from './streaming.mjs';
import { sendApprovalDecision, sendCallback } from './callback-client.mjs';
import { HookRunner } from '../config/hook-runner.mjs';
import { buildFileDiff } from './file-diff.mjs';
import { buildWorkScope } from './work-scope.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Create a tool executor that bridges Tarang tool names to OCC tools.
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
} = {}) {
    const occRegistry = createToolRegistry();
    const skillTool = occRegistry.get('Skill');
    if (skillTool) skillTool._skillsLoader = skillsLoader;
    const installer = skillInstaller || new SkillInstaller({
        cwd: process.cwd(),
        homeDir: skillsLoader.homeDir || os.homedir(),
    });
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
        const hint = /command substitution|backticks|\$\(\)/i.test(text)
            ? 'Retry with separate simple shell commands instead of backticks or $().'
            : 'Work only inside a registered project root.';
        return `BLOCKED: ${text}. ${hint}`;
    }

    function longRunningObservationTimeoutMs() {
        const configured = Number(process.env.KEPLER_LONG_RUNNING_TIMEOUT_MS);
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

    function agentMatches(agent, query) {
        const needle = String(query || '').trim().toLowerCase();
        if (!needle) return true;
        return [
            agent.slug,
            agent.name,
            agent.description,
            agent.role,
            agent.model,
            ...(Array.isArray(agent.tools) ? agent.tools : []),
            ...(Array.isArray(agent.capabilities) ? agent.capabilities : []),
            ...(Array.isArray(agent.domains) ? agent.domains : []),
        ].some(value => String(value || '').toLowerCase().includes(needle));
    }

    function compactAgentMetadata(agent) {
        return {
            slug: agent.slug,
            name: agent.name,
            description: agent.description || '',
            role: agent.role || 'specialist',
            model: agent.model || null,
            models: agent.models && Object.keys(agent.models).length ? agent.models : undefined,
            tools: Array.isArray(agent.tools) ? agent.tools : [],
            capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
            domains: Array.isArray(agent.domains) ? agent.domains : [],
            source_scope: agent.source_scope || 'unknown',
            source: agent.source || '',
            content_hash: agent.content_hash || '',
        };
    }

    function filterLocalAgents(args = {}) {
        const scope = String(args.scope || '').trim();
        if (scope && scope !== 'project' && scope !== 'global') {
            throw new Error('scope must be "project" or "global"');
        }
        return listLocalAgents(process.cwd())
            .filter(agent => !scope || agent.source_scope === scope)
            .filter(agent => agentMatches(agent, args.query || args.name || ''));
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
     * Wrap an OCC string result into Tarang's { success, output } format.
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

    const LINT_COMMANDS = {
        '.py':  (file) => `python3 -m py_compile "${file}" 2>&1`,
        '.js':  (file) => `npx eslint --no-eslintrc --rule '{}' "${file}" 2>&1 || true`,
        '.ts':  (file) => `npx tsc --noEmit --pretty "${file}" 2>&1 || true`,
        '.tsx': (file) => `npx tsc --noEmit --pretty "${file}" 2>&1 || true`,
        '.go':  (file) => `go vet "${file}" 2>&1`,
        '.rs':  (file) => `rustfmt --check "${file}" 2>&1`,
    };

    // tsc --pretty and eslint emit ANSI codes (including background-red
    // highlights) which bleed when our renderer slices the first 80 chars.
    // Strip color codes so the stored lint string is always plain text.
    const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
    function stripAnsi(s) { return String(s || '').replace(ANSI_RE, ''); }

    function autoLint(filePath) {
        const ext = path.extname(filePath);
        const cmdFn = LINT_COMMANDS[ext];
        if (!cmdFn) return null;

        try {
            const output = execSync(cmdFn(filePath), {
                encoding: 'utf-8',
                timeout: 15_000,
                cwd: process.cwd(),
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
            });
            const trimmed = stripAnsi(output).trim();
            if (!trimmed) return null;
            return trimmed;
        } catch (err) {
            // Non-zero exit means lint errors found
            const output = stripAnsi(err.stderr || err.stdout || '').trim();
            if (!output) return null;
            return output;
        }
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

    async function executeToolWithHooks(name, args, options = {}) {
        const handler = toolMap[name];
        if (!handler) {
            return { success: false, output: `Unknown tool: ${name}`, _tool: name };
        }
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
            const result = await occRegistry.call('Bash', {
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

            return {
                success,
                output: filtered.output,
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

                    const result = await occRegistry.call('Read', {
                        file_path: filePath,
                        offset,
                        limit,
                    });
                    const output = typeof result === 'string' ? result : String(result);
                    const content = output.replace(/^\s*\d+[→\t]/gm, '');
                    const actNudge = solutionNudge(filePath);
                    return {
                        success: !isError(output),
                        content,
                        output: output + nudge + actNudge,
                        _tool: 'read_file',
                        _output_type: 'file_content',
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
                    await occRegistry.call('Read', { file_path: filePath, limit: 1 });
                }
            } catch { /* file may not exist yet */ }
            // Checkpoint before overwrite so /undo can restore the previous content.
            if (checkpoints && fs.existsSync(filePath)) {
                try { checkpoints.save(filePath); } catch { /* best effort */ }
            }
            const result = await occRegistry.call('Write', {
                file_path: filePath,
                content: args.content,
            });
            const wrapped = wrapResult(result, 'write_file');
            const after = readTextIfExists(filePath);
            attachFileDiff(wrapped, filePath, before, after);
            updateProjectIndex(filePath);

            // Auto-lint the written file
            const lintOutput = autoLint(filePath);
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
                            await occRegistry.call('Read', { file_path: filePath, limit: 1 });
                        }
                    } catch { /* file may not exist yet */ }

                    await occRegistry.call('Write', { file_path: filePath, content });
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
            const filePath = await resolvePath(rawPath, args);
            const before = readTextIfExists(filePath);
            const writeCheck = validateWrite(filePath, args.replace, projectRootFor(filePath));
            if (!writeCheck.safe) {
                return { success: false, output: `BLOCKED: ${writeCheck.reason}`, _tool: 'edit_file', _blocked: true };
            }
            // OCC Edit requires Read first
            try {
                await occRegistry.call('Read', { file_path: filePath, limit: 1 });
            } catch { /* best effort */ }

            // Checkpoint before edit so /undo can restore the previous content.
            if (checkpoints) {
                try { checkpoints.save(filePath); } catch { /* best effort */ }
            }

            let result;
            try {
                result = await occRegistry.call('Edit', {
                    file_path: filePath,
                    old_string: args.search,
                    new_string: args.replace,
                    replace_all: args.replace_all || false,
                });
            } catch (editErr) {
                // OCC Edit failed (string not found) — fallback to Python replacement
                try {
                    const search = args.search.replace(/'/g, "\\'").replace(/\n/g, "\\n");
                    const replace = args.replace.replace(/'/g, "\\'").replace(/\n/g, "\\n");
                    const pyCmd = `python3 -c "
import sys
with open('${filePath}', 'r') as f: content = f.read()
old = '''${args.search}'''
new = '''${args.replace}'''
if old not in content:
    print('ERROR: search string not found in file', file=sys.stderr)
    sys.exit(1)
content = content.replace(old, new, 1)
with open('${filePath}', 'w') as f: f.write(content)
print('OK: replaced')
"`;
                    const fallbackResult = execSync(pyCmd, {
                        encoding: 'utf-8',
                        timeout: 5000,
                        cwd: projectRootFor(filePath),
                    });
                    result = `Edited ${filePath} (via fallback): ${fallbackResult.trim()}`;
                } catch (sedErr) {
                    return { success: false, output: `edit_file failed: ${editErr?.message || 'unknown'}. Fallback also failed: ${sedErr?.message || 'unknown'}. Try shell(sed) manually.`, _tool: 'edit_file' };
                }
            }

            const wrapped = wrapResult(result, 'edit_file');
            const after = readTextIfExists(filePath);
            attachFileDiff(wrapped, filePath, before, after);
            updateProjectIndex(filePath);
            _hasEdited = true;

            // Auto-lint the edited file
            const lintOutput = autoLint(filePath);
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
                    const result = await occRegistry.call('Glob', {
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
                        const result = await occRegistry.call('Glob', {
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
                    const result = await occRegistry.call('Grep', {
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

        // ── Tarang-specific tools (no OCC bridge) ──────────────

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
                const output = await occRegistry.call('Bash', {
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
                const ext = path.extname(filePath);
                let cmd;
                if (ext === '.py') cmd = `python3 -m ruff check "${filePath}" 2>&1 || true`;
                else if (['.js', '.mjs', '.ts', '.tsx'].includes(ext)) cmd = `npx eslint "${filePath}" 2>&1 || true`;
                else return { success: true, issues: [], message: 'No linter for this file type', _tool: 'lint_check' };

                const output = await occRegistry.call('Bash', {
                    command: cmd,
                    timeout: 30_000,
                    description: `Lint: ${path.basename(filePath)}`,
                    cwd: projectRootFor(filePath),
                    signal: options.signal,
                });
                const rawOutput = typeof output === 'string' ? output : String(output);
                if (/^Error:\s*Command cancelled by user/i.test(rawOutput)) {
                    return { success: false, output: 'Cancelled by user', _cancelled: true, _tool: 'lint_check' };
                }
                return { success: true, output: rawOutput, issues: rawOutput.split('\n').filter(Boolean), _tool: 'lint_check' };
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
                const output = await occRegistry.call('Bash', {
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
        agents_list: async (args = {}) => {
            const agents = filterLocalAgents(args).map(compactAgentMetadata);
            const payload = { agents, count: agents.length };
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
                    `Run /agents sync ${result.slug} when ready`,
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
            const creds = new TarangAuth().loadCredentials();
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
                const creds = new TarangAuth().loadCredentials();
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
            const creds = new TarangAuth().loadCredentials();
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
            const creds = new TarangAuth().loadCredentials();
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

    return {
        /**
         * Execute a Tarang tool by name.
         * @param {string} name - Tarang tool name
         * @param {Object} args - Tool arguments
         * @returns {Promise<Object>} - { success, output, ... }
         */
        async execute(name, args, options = {}) {
            return executeToolWithHooks(name, args, options);
        },

        /** List all available tool names. */
        listTools() {
            return Object.keys(toolMap);
        },

        getProjectResources() {
            return projectRegistry.resources();
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

        getAgentContext() {
            const global = projectRegistry.getGlobalContext();
            return {
                identity: global.identity,
                preferences: global.preferences,
                global_skills: skillsLoader.list(),
                available_agents: listLocalAgents(process.cwd()).map(agent => ({
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
                    spec: agent.spec,
                })),
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
