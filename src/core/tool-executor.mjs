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
import { validatePath, validateDelete, validateShellCommand, validateWrite } from './safety.mjs';
import { classifyCommand, isExitCodeError } from '../permissions/command-classifier.mjs';
import { analyzeCode } from '../context/ast-parser.mjs';
import { ProjectRegistry } from '../tools/project-overview.mjs';
import { SkillInstaller } from '../skills/installer.mjs';
import { SkillsLoader } from '../skills/loader.mjs';
import { HookRunner } from '../config/hook-runner.mjs';
import { buildFileDiff } from './file-diff.mjs';
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
        result.output = `[Kepler reused prior ${kind} result; source unchanged.]${excerpt ? `\n\n${excerpt}` : ''}`;
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

    function attachFileDiff(result, filePath, before, after) {
        try {
            const diff = buildFileDiff({
                filePath,
                before,
                after,
                cwd: projectRootFor(filePath),
            });
            result.file_diff = diff;
            result.diff = diff.unified;
            result.lines_added = diff.lines_added;
            result.lines_removed = diff.lines_removed;
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

    // ── Tool mapping table ──────────────────────────────────────

    const toolMap = {
        // 1. shell → Bash + classification + smart output filtering
        shell: async (args) => {
            // Phase 1: legacy safety check (kept for backward compat)
            const shellCheck = validateShellCommand(args.command);
            if (!shellCheck.safe) {
                return {
                    success: false,
                    output: `BLOCKED: ${shellCheck.reason}. Work only inside a registered project root.`,
                    _tool: 'shell', _blocked: true,
                };
            }

            // Phase 2: command classifier (PRD-050)
            const classification = classifyCommand(args.command);
            if (classification.classification === 'blocked') {
                return {
                    success: false,
                    output: `BLOCKED: ${classification.reason}`,
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
            });
            const rawOutput = typeof result === 'string' ? result : String(result);
            const timedOut = /^Error:\s*Command timed out after \d+ms/i.test(rawOutput);
            const exitMatch = rawOutput.match(/Exit code: (\d+)/);
            const exitCode = timedOut ? 124 : (exitMatch ? parseInt(exitMatch[1]) : 0);
            // Semantic exit code: grep returns 1 for "no matches" (not an error)
            const success = observationTimeout && timedOut ? true : (!timedOut && !isExitCodeError(args.command, exitCode));

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
                    diffs.push(buildFileDiff({
                        filePath,
                        before,
                        after,
                        cwd: projectRootFor(filePath),
                    }));
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
        validate_build: async (args) => {
            try {
                let cmd = args.command;
                const cwd = await commandCwd(args);
                if (!cmd) {
                    if (fs.existsSync(path.join(cwd, 'package.json'))) cmd = 'npm run build';
                    else if (fs.existsSync(path.join(cwd, 'Makefile'))) cmd = 'make';
                    else if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) cmd = 'cargo build';
                    else return { success: false, output: 'No build system detected', _tool: 'validate_build' };
                }
                const output = execSync(cmd, { stdio: 'pipe', timeout: 120_000, cwd }).toString();
                return { success: true, output, _tool: 'validate_build' };
            } catch (err) {
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
        lint_check: async (args) => {
            try {
                const filePath = await resolvePath(args.file_path || args.path, args);
                const ext = path.extname(filePath);
                let cmd;
                if (ext === '.py') cmd = `python3 -m ruff check "${filePath}" 2>&1 || true`;
                else if (['.js', '.mjs', '.ts', '.tsx'].includes(ext)) cmd = `npx eslint "${filePath}" 2>&1 || true`;
                else return { success: true, issues: [], message: 'No linter for this file type', _tool: 'lint_check' };

                const output = execSync(cmd, { stdio: 'pipe', timeout: 30_000, cwd: projectRootFor(filePath) }).toString();
                return { success: true, output, issues: output.split('\n').filter(Boolean), _tool: 'lint_check' };
            } catch (err) {
                return { success: false, output: err.message, _tool: 'lint_check' };
            }
        },

        // 15. run_tests
        run_tests: async (args) => {
            try {
                const cmd = args.command || 'npm test';
                const cwd = await commandCwd(args);
                const output = execSync(cmd, {
                    stdio: 'pipe', timeout: 120_000, cwd,
                    encoding: 'utf-8',
                }).toString();
                return { success: true, output: output.slice(-3000), _tool: 'run_tests' };
            } catch (err) {
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
    };

    return {
        /**
         * Execute a Tarang tool by name.
         * @param {string} name - Tarang tool name
         * @param {Object} args - Tool arguments
         * @returns {Promise<Object>} - { success, output, ... }
         */
        async execute(name, args) {
            const handler = toolMap[name];
            if (!handler) {
                return { success: false, output: `Unknown tool: ${name}`, _tool: name };
            }
            const hooks = hookRunner || new HookRunner({ cwd: process.cwd() });
            try {
                const pre = await hooks.run('PreToolUse', { toolName: name, input: args || {} });
                if (pre.blocked) {
                    return { success: false, output: `BLOCKED by hook: ${pre.message}`, _tool: name, _blocked: true };
                }
                let result = await handler(args);
                const post = await hooks.run('PostToolUse', { toolName: name, input: args || {}, result });
                for (const item of post.results || []) {
                    if (item.parsed?.modifiedResult !== undefined) result = item.parsed.modifiedResult;
                    if (item.parsed?.feedback && result && typeof result === 'object') {
                        result.output = `${result.output || ''}\n\n--- Hook Feedback ---\n${item.parsed.feedback}`.trim();
                    }
                }
                return result;
            } catch (err) {
                return { success: false, output: `Tool error (${name}): ${err.message}`, _tool: name };
            }
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
                    const result = await projectRegistry.register(root, { forceRefresh });
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
