/**
 * Tool Executor Bridge — maps Tarang backend tool names to OCC tool calls.
 *
 * The Tarang backend sends tool_request events with its own tool names and arg shapes.
 * This bridge translates those into OCC tool calls and wraps the results.
 *
 * Safety guardrails integrated — prevents destructive operations on source code.
 * 14 tools mapped: 7 OCC-bridged + 7 Tarang-specific.
 */

import { createToolRegistry } from '../tools/registry.mjs';
import { filterOutput } from './output-filter.mjs';
import { validatePath, validateDelete, validateShellCommand, validateWrite } from './safety.mjs';
import { ContextRetriever } from '../context/retriever.mjs';
import { analyzeCode } from '../context/ast-parser.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Create a tool executor that bridges Tarang tool names to OCC tools.
 * @param {Object} [options]
 * @param {ContextRetriever} [options.retriever] - BM25 retriever for search_code
 * @returns {{ execute(name, args): Promise<Object>, listTools(): string[] }}
 */
export function createToolExecutor({ retriever } = {}) {
    const occRegistry = createToolRegistry();
    let _searchCodeUsed = false; // tracks if search_code was called (for read_file nudge)

    /**
     * Resolve a path relative to CWD, with traversal protection.
     */
    function resolvePath(p) {
        if (!p) return process.cwd();
        const resolved = path.resolve(process.cwd(), p);
        // Prevent path traversal outside CWD's parent
        const cwd = process.cwd();
        const cwdParent = path.dirname(cwd);
        if (!resolved.startsWith(cwdParent)) {
            throw new Error(`Path traversal blocked: ${p}`);
        }
        return resolved;
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

    // ── Tool mapping table ──────────────────────────────────────

    const toolMap = {
        // 1. shell → Bash + smart output filtering + safety check
        shell: async (args) => {
            const shellCheck = validateShellCommand(args.command);
            if (!shellCheck.safe) {
                return {
                    success: false,
                    output: `BLOCKED: ${shellCheck.reason}. Your current working directory is ${process.cwd()} — search within it, not from filesystem root.`,
                    _tool: 'shell', _blocked: true,
                };
            }
            if (shellCheck.highRisk) {
                // highRisk flag — the approval manager will catch this,
                // but tag it so the REPL can show a warning
                args._highRisk = true;
                args._riskReason = shellCheck.reason;
            }

            // Pre-check: if command is rm/unlink, verify targets exist first
            const rmMatch = (args.command || '').match(/^rm\s+(?:-\w+\s+)*(.+)$/);
            if (rmMatch) {
                const targets = rmMatch[1].split(/\s+/).filter(t => !t.startsWith('-'));
                const missing = targets.filter(t => {
                    try { return !fs.existsSync(path.resolve(process.cwd(), t)); } catch { return true; }
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
            });
            const rawOutput = typeof result === 'string' ? result : String(result);
            const exitMatch = rawOutput.match(/Exit code: (\d+)/);
            const success = !exitMatch || exitMatch[1] === '0';

            // Apply smart filtering based on command type
            const filtered = filterOutput(rawOutput, args.command, success);

            return {
                success,
                output: filtered.output,
                exit_code: exitMatch ? parseInt(exitMatch[1]) : 0,
                _tool: 'shell',
                _commandType: filtered.commandType,
                _filtered: filtered.truncated || filtered.originalLines !== filtered.filteredLines,
            };
        },

        // 2. read_file → Read (with smart truncation for large files)
        read_file: async (args) => {
            const filePath = resolvePath(args.file_path || args.path);
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
            return {
                success: !isError(output),
                content,
                output: output + nudge,
                _tool: 'read_file',
                _output_type: 'file_content',
            };
        },

        // 3. write_file → Write + auto-lint + safety check
        write_file: async (args) => {
            const rawPath = args.file_path || args.path;
            if (!rawPath || rawPath === 'file' || rawPath.length < 3) {
                return { success: false, output: `Error: Invalid file path "${rawPath || ''}". Use an ABSOLUTE path like "${process.cwd()}/src/main.py"`, _tool: 'write_file' };
            }
            const filePath = resolvePath(rawPath);
            const writeCheck = validateWrite(filePath, args.content);
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

            // Auto-lint the written file
            const lintOutput = autoLint(filePath);
            if (lintOutput) {
                wrapped.output += `\n\n--- Lint result ---\n${lintOutput}`;
                wrapped.lint = lintOutput;
            }

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
                const filePath = resolvePath(rawPath);
                const content = file.content || '';

                const writeCheck = validateWrite(filePath, content);
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

        // 4. edit_file → Edit + auto-lint
        edit_file: async (args) => {
            const rawPath = args.file_path || args.path;
            const filePath = resolvePath(rawPath);
            // OCC Edit requires Read first
            try {
                await occRegistry.call('Read', { file_path: filePath, limit: 1 });
            } catch { /* best effort */ }
            const result = await occRegistry.call('Edit', {
                file_path: filePath,
                old_string: args.search,
                new_string: args.replace,
                replace_all: args.replace_all || false,
            });
            const wrapped = wrapResult(result, 'edit_file');

            // Auto-lint the edited file
            const lintOutput = autoLint(filePath);
            if (lintOutput) {
                wrapped.output += `\n\n--- Lint result ---\n${lintOutput}`;
                wrapped.lint = lintOutput;
            }

            return wrapped;
        },

        // 5. list_files → Glob
        list_files: async (args) => {
            const result = await occRegistry.call('Glob', {
                pattern: args.pattern || '**/*',
                path: args.path ? resolvePath(args.path) : undefined,
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

        // 6. search_code → rg (ripgrep) primary, BM25 secondary
        search_code: async (args) => {
            _searchCodeUsed = true;
            const query = args.query || args.pattern;
            if (!query) return { success: false, output: 'query required', _tool: 'search_code' };

            const searchPath = args.path ? resolvePath(args.path) : process.cwd();

            // Primary: ripgrep — fast, reliable, always works
            try {
                const safeQuery = query.replace(/['"\\]/g, '\\$&');
                const cmd = `rg -n -C 1 --max-count 5 --max-filesize 500K -e ${JSON.stringify(query)} ${JSON.stringify(searchPath)} 2>/dev/null | head -60`;
                const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd: searchPath }).trim();
                if (output) {
                    return { success: true, output, _tool: 'search_code', _method: 'rg' };
                }
            } catch { /* rg not found or no results */ }

            // Secondary: BM25 retriever (if indexed)
            if (retriever) {
                if (!retriever.index) retriever.loadIndex();
                const chunks = retriever.retrieve(query, 8);
                if (chunks.length > 0) {
                    const output = chunks.map(c => {
                        const score = c.score?.toFixed(2) || '?';
                        return `── ${c.id} (score: ${score}) ──\n${c.text}`;
                    }).join('\n\n');
                    return { success: true, output, chunks: chunks.length, _tool: 'search_code', _method: 'bm25' };
                }
            }

            // Tertiary: OCC Grep tool
            try {
                const result = await occRegistry.call('Grep', {
                    pattern: query, path: searchPath, output_mode: 'content', '-n': true, head_limit: 30,
                });
                const output = typeof result === 'string' ? result : String(result);
                if (output?.trim() && !output.includes('No matches found')) {
                    return { success: true, output, _tool: 'search_code', _method: 'grep' };
                }
            } catch { /* fall through */ }

            // Nothing found — give actionable hint
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
                    path: args.path ? resolvePath(args.path) : undefined,
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
                path: args.path ? resolvePath(args.path) : undefined,
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

        // ── Tarang-specific tools (no OCC bridge) ──────────────

        // 8. read_files → batch Read (with AST truncation for large files)
        read_files: async (args) => {
            const paths = args.file_paths || args.paths || [];
            const results = [];
            for (const p of paths) {
                try {
                    const filePath = resolvePath(p);
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
                const filePath = resolvePath(args.file_path || args.path);
                const delCheck = validateDelete(filePath);
                if (!delCheck.safe) {
                    return { success: false, output: `🛡️ BLOCKED: ${delCheck.reason}`, _tool: 'delete_file', _blocked: true };
                }
                fs.unlinkSync(filePath);
                return { success: true, message: `Deleted ${args.path}`, _tool: 'delete_file' };
            } catch (err) {
                return { success: false, output: `Error: ${err.message}`, _tool: 'delete_file' };
            }
        },

        // 10. get_file_info
        get_file_info: async (args) => {
            try {
                const filePath = resolvePath(args.file_path || args.path);
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
                const filePath = resolvePath(args.path);
                const ext = path.extname(filePath);
                let cmd;
                if (ext === '.py') cmd = `python3 -m py_compile "${filePath}"`;
                else if (ext === '.js' || ext === '.mjs') cmd = `node --check "${filePath}"`;
                else return { success: true, valid: true, message: 'No validator for this file type', _tool: 'validate_file' };

                execSync(cmd, { stdio: 'pipe' });
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
                    if (fs.existsSync('package.json')) cmd = 'npm run build';
                    else if (fs.existsSync('Makefile')) cmd = 'make';
                    else if (fs.existsSync('Cargo.toml')) cmd = 'cargo build';
                    else return { success: false, output: 'No build system detected', _tool: 'validate_build' };
                }
                const output = execSync(cmd, { stdio: 'pipe', timeout: 120_000 }).toString();
                return { success: true, output, _tool: 'validate_build' };
            } catch (err) {
                return { success: false, output: err.stderr?.toString() || err.message, _tool: 'validate_build' };
            }
        },

        // 13. validate_structure
        validate_structure: async (args) => {
            const expected = args.expected || [];
            const missing = expected.filter(f => !fs.existsSync(resolvePath(f)));
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
                const filePath = resolvePath(args.file_path || args.path);
                const ext = path.extname(filePath);
                let cmd;
                if (ext === '.py') cmd = `python3 -m ruff check "${filePath}" 2>&1 || true`;
                else if (['.js', '.mjs', '.ts', '.tsx'].includes(ext)) cmd = `npx eslint "${filePath}" 2>&1 || true`;
                else return { success: true, issues: [], message: 'No linter for this file type', _tool: 'lint_check' };

                const output = execSync(cmd, { stdio: 'pipe', timeout: 30_000 }).toString();
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
                    stdio: 'pipe', timeout: 120_000, cwd: process.cwd(),
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
                    stdio: 'pipe', timeout: 10_000, cwd: process.cwd(), encoding: 'utf-8',
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
                    stdio: 'pipe', timeout: 10_000, cwd: process.cwd(), encoding: 'utf-8',
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
            const filePath = resolvePath(args.file_path || args.path);
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
    };
}
