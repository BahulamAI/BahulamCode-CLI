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
import { filterOutput } from './output-filter.mjs';
import { validatePath, validateDelete, validateShellCommand, validateWrite } from './safety.mjs';
import { classifyCommand, isExitCodeError } from '../permissions/command-classifier.mjs';
import { analyzeCode } from '../context/ast-parser.mjs';
import { ProjectRegistry } from '../tools/project-overview.mjs';
import { SkillsLoader } from '../skills/loader.mjs';
import * as fs from 'node:fs';
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
} = {}) {
    const occRegistry = createToolRegistry();
    const skillTool = occRegistry.get('Skill');
    if (skillTool) skillTool._skillsLoader = skillsLoader;
    let _searchCodeUsed = false; // tracks if search_code was called (for read_file nudge)

    function resolvePath(p, args = {}, options = {}) {
        return projectRegistry.resolvePath(p, args.project_id, options);
    }

    function projectRootFor(filePath) {
        const project = projectRegistry.projectForPath(filePath);
        if (!project) throw new Error(`No registered project contains path: ${filePath}`);
        return project.resource.root;
    }

    function commandCwd(args = {}) {
        return resolvePath(args.cwd || null, args);
    }

    function updateProjectIndex(filePath) {
        try {
            projectRegistry.projectForPath(filePath)?.retriever.updateFile(filePath);
        } catch { /* best effort */ }
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
            });
            const trimmed = output.trim();
            if (!trimmed) return null;
            return trimmed;
        } catch (err) {
            // Non-zero exit means lint errors found
            const output = (err.stderr || err.stdout || '').trim();
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
            const cwd = commandCwd(args);

            // Pre-check: if command is rm/unlink, verify targets exist first
            const rmMatch = (args.command || '').match(/^rm\s+(?:-\w+\s+)*(.+)$/);
            if (rmMatch) {
                const targets = rmMatch[1].split(/\s+/).filter(t => !t.startsWith('-'));
                const missing = targets.filter(t => {
                    try { return !fs.existsSync(path.resolve(cwd, t)); } catch { return true; }
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

            const result = await occRegistry.call('Bash', {
                command: args.command,
                timeout: args.timeout,
                description: args.description || `Run: ${(args.command || '').slice(0, 50)}`,
                cwd,
            });
            const rawOutput = typeof result === 'string' ? result : String(result);
            const exitMatch = rawOutput.match(/Exit code: (\d+)/);
            const exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
            // Semantic exit code: grep returns 1 for "no matches" (not an error)
            const success = !isExitCodeError(args.command, exitCode);

            // Apply smart filtering based on command type
            const filtered = filterOutput(rawOutput, args.command, success);

            return {
                success,
                output: filtered.output,
                exit_code: exitCode,
                _tool: 'shell',
                _classification: args._classification,
                _commandType: filtered.commandType,
                _filtered: filtered.truncated || filtered.originalLines !== filtered.filteredLines,
            };
        },

        // 2. read_file → Read (with smart truncation for large files)
        read_file: async (args) => {
            const filePath = resolvePath(args.file_path || args.path, args);
            const hasLineRange = args.start_line || args.end_line || args.offset || args.limit;

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

            // Convert start_line/end_line to offset/limit
            const offset = args.start_line ? args.start_line - 1 : args.offset;
            const limit = (args.start_line && args.end_line)
                ? (args.end_line - args.start_line + 1)
                : args.limit;

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

        // 3. write_file → Write + auto-lint + safety check
        write_file: async (args) => {
            const rawPath = args.file_path || args.path;
            if (!rawPath || rawPath === 'file' || rawPath.length < 3) {
                return { success: false, output: `Error: Invalid file path "${rawPath || ''}". Register the project, then use an absolute path.`, _tool: 'write_file' };
            }
            const filePath = resolvePath(rawPath, args, { allowMissing: true });
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
            const result = await occRegistry.call('Write', {
                file_path: filePath,
                content: args.content,
            });
            const wrapped = wrapResult(result, 'write_file');
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

            for (const file of files) {
                const rawPath = file.path || file.file_path;
                if (!rawPath) {
                    errors.push('Missing path in file entry');
                    continue;
                }
                const filePath = resolvePath(rawPath, file, { allowMissing: true });
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

                    // Read first if exists (OCC Write requirement)
                    try {
                        if (fs.existsSync(filePath)) {
                            await occRegistry.call('Read', { file_path: filePath, limit: 1 });
                        }
                    } catch { /* file may not exist yet */ }

                    await occRegistry.call('Write', { file_path: filePath, content });
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
                    _tool: 'write_project',
                };
            }

            return { success: true, output, files_written: results, _tool: 'write_project' };
        },

        // 4. edit_file → Edit + auto-lint + auto-fallback to sed
        edit_file: async (args) => {
            const rawPath = args.file_path || args.path;
            const filePath = resolvePath(rawPath, args);
            const writeCheck = validateWrite(filePath, args.replace, projectRootFor(filePath));
            if (!writeCheck.safe) {
                return { success: false, output: `BLOCKED: ${writeCheck.reason}`, _tool: 'edit_file', _blocked: true };
            }
            // OCC Edit requires Read first
            try {
                await occRegistry.call('Read', { file_path: filePath, limit: 1 });
            } catch { /* best effort */ }

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
            const result = await occRegistry.call('Glob', {
                pattern: args.pattern || '**/*',
                path: resolvePath(args.path || null, args),
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
                project = projectRegistry.projectForPath(resolvePath(args.path, args));
            } else if (projectRegistry.resources().length === 1) {
                project = projectRegistry.get(projectRegistry.resources()[0].project_id);
            } else {
                return {
                    success: false,
                    output: 'search_code requires project_id when multiple or no projects are registered',
                    _tool: 'search_code',
                };
            }
            const searchPath = args.path ? resolvePath(args.path, args) : project.resource.root;
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

            // If it looks like a glob pattern, use Glob
            if (query.includes('*') || query.includes('?')) {
                const result = await occRegistry.call('Glob', {
                    pattern: query,
                    path: resolvePath(args.path || null, args),
                });
                const output = typeof result === 'string' ? result : String(result);
                return {
                    success: true,
                    files: output.split('\n').filter(Boolean),
                    output,
                    _tool: 'search_files',
                };
            }

            // For text patterns: grep with context lines (like grep -n -C 3)
            const result = await occRegistry.call('Grep', {
                pattern: query,
                path: resolvePath(args.path || null, args),
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

        // 7b. grep → dedicated ripgrep tool (fast text/regex search)
        grep: async (args) => {
            const pattern = args.pattern;
            if (!pattern) return { success: false, output: 'pattern required', _tool: 'grep' };

            const searchPath = resolvePath(args.path || null, args);
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
            const paths = args.file_paths || args.paths || [];
            const results = [];
            for (const p of paths) {
                try {
                    const filePath = resolvePath(p, args);
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n').length;

                    if (lines > 50) {
                        // Large file: return AST summary instead of full content
                        const analysis = analyzeCode(filePath);
                        results.push({
                            path: p, lines,
                            content: analysis.summary,
                            _truncated: true,
                            success: true,
                        });
                    } else {
                        results.push({ path: p, content, success: true });
                    }
                } catch (err) {
                    results.push({ path: p, error: err.message, success: false });
                }
            }
            return { success: true, files: results, _tool: 'read_files' };
        },

        // 9. delete_file + safety check
        delete_file: async (args) => {
            try {
                const filePath = resolvePath(args.file_path || args.path, args);
                const delCheck = validateDelete(filePath, projectRootFor(filePath));
                if (!delCheck.safe) {
                    return { success: false, output: `🛡️ BLOCKED: ${delCheck.reason}`, _tool: 'delete_file', _blocked: true };
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
                const filePath = resolvePath(args.file_path || args.path, args);
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
                const filePath = resolvePath(args.path, args);
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
                if (!cmd) {
                    const cwd = commandCwd(args);
                    if (fs.existsSync(path.join(cwd, 'package.json'))) cmd = 'npm run build';
                    else if (fs.existsSync(path.join(cwd, 'Makefile'))) cmd = 'make';
                    else if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) cmd = 'cargo build';
                    else return { success: false, output: 'No build system detected', _tool: 'validate_build' };
                }
                const output = execSync(cmd, { stdio: 'pipe', timeout: 120_000, cwd: commandCwd(args) }).toString();
                return { success: true, output, _tool: 'validate_build' };
            } catch (err) {
                return { success: false, output: err.stderr?.toString() || err.message, _tool: 'validate_build' };
            }
        },

        // 13. validate_structure
        validate_structure: async (args) => {
            const expected = args.expected || [];
            const missing = expected.filter(f =>
                !fs.existsSync(resolvePath(f, args, { allowMissing: true }))
            );
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
                const filePath = resolvePath(args.file_path || args.path, args);
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
                const output = execSync(cmd, {
                    stdio: 'pipe', timeout: 120_000, cwd: commandCwd(args),
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
                const output = execSync(`git diff ${filePath}`, {
                    stdio: 'pipe', timeout: 10_000, cwd: commandCwd(args), encoding: 'utf-8',
                }).toString();
                return { success: true, output: output.slice(-5000) || '(no changes)', _tool: 'git_diff' };
            } catch (err) {
                return { success: false, output: err.message, _tool: 'git_diff' };
            }
        },

        // 17. git_status
        git_status: async (args) => {
            try {
                const output = execSync('git status --short', {
                    stdio: 'pipe', timeout: 10_000, cwd: commandCwd(args), encoding: 'utf-8',
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
            const filePath = resolvePath(args.file_path || args.path, args);
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
            const result = await projectRegistry.register(projectPath);
            return {
                success: true,
                output: result.output,
                project_resource: result.resource,
                already_registered: result.already_registered,
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
            try {
                return await handler(args);
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
