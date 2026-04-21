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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Create a tool executor that bridges Tarang tool names to OCC tools.
 * @returns {{ execute(name, args): Promise<Object>, listTools(): string[] }}
 */
export function createToolExecutor() {
    const occRegistry = createToolRegistry();

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
                return { success: false, output: `🛡️ BLOCKED: ${shellCheck.reason}`, _tool: 'shell', _blocked: true };
            }
            if (shellCheck.highRisk) {
                // highRisk flag — the approval manager will catch this,
                // but tag it so the REPL can show a warning
                args._highRisk = true;
                args._riskReason = shellCheck.reason;
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

        // 2. read_file → Read
        read_file: async (args) => {
            const filePath = resolvePath(args.path);
            const result = await occRegistry.call('Read', {
                file_path: filePath,
                offset: args.offset,
                limit: args.limit,
            });
            const output = typeof result === 'string' ? result : String(result);
            // Strip line number prefixes (cat -n format)
            const content = output.replace(/^\s*\d+[→\t]/gm, '');
            return {
                success: !isError(output),
                content,
                output,
                _tool: 'read_file',
                _output_type: 'file_content',
            };
        },

        // 3. write_file → Write + auto-lint + safety check
        write_file: async (args) => {
            const filePath = resolvePath(args.path);
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

        // 4. edit_file → Edit + auto-lint
        edit_file: async (args) => {
            const filePath = resolvePath(args.path);
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

        // 6. search_code → Grep
        search_code: async (args) => {
            const result = await occRegistry.call('Grep', {
                pattern: args.pattern,
                path: args.path ? resolvePath(args.path) : undefined,
                output_mode: args.output_mode || 'content',
            });
            return {
                success: true,
                matches: typeof result === 'string' ? result : String(result),
                output: typeof result === 'string' ? result : String(result),
                _tool: 'search_code',
            };
        },

        // 7. search_files → Glob (construct glob from query)
        search_files: async (args) => {
            const query = args.query || args.pattern || '*';
            const pattern = query.includes('*') ? query : `**/*${query}*`;
            const result = await occRegistry.call('Glob', {
                pattern,
                path: args.path ? resolvePath(args.path) : undefined,
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

        // 8. read_files → batch Read
        read_files: async (args) => {
            const paths = args.paths || [];
            const results = [];
            for (const p of paths) {
                try {
                    const filePath = resolvePath(p);
                    const content = fs.readFileSync(filePath, 'utf-8');
                    results.push({ path: p, content, success: true });
                } catch (err) {
                    results.push({ path: p, error: err.message, success: false });
                }
            }
            return { success: true, files: results, _tool: 'read_files' };
        },

        // 9. delete_file + safety check
        delete_file: async (args) => {
            try {
                const filePath = resolvePath(args.path);
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
                const filePath = resolvePath(args.path);
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
                const filePath = resolvePath(args.path);
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
