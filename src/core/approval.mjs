/**
 * Approval Flow — T11: Y/n/v/a/t approval state machine.
 *
 * Write tools (shell, write_file, edit_file, delete_file) require approval.
 * Read tools (read_file, list_files, search_code, etc.) auto-approve.
 */

import * as readline from 'node:readline';

const WRITE_TOOLS = new Set([
    'shell', 'write_file', 'edit_file', 'delete_file',
    'validate_build', 'lint_check',
]);

export class ApprovalManager {
    constructor({ autoApprove = false, planMode = false } = {}) {
        this.autoApprove = autoApprove;     // --yes flag
        this.planMode = planMode;           // --plan flag (read-only)
        this.approveAll = false;            // 'a' pressed
        this.approvedToolTypes = new Set(); // 't' pressed for these
    }

    /**
     * Check if a tool call should be approved.
     * @param {string} toolName
     * @param {Object} args
     * @param {boolean} requireApproval - from backend
     * @returns {Promise<{approved: boolean, reason?: string}>}
     */
    async check(toolName, args, requireApproval = false) {
        // Plan mode: reject all writes
        if (this.planMode && WRITE_TOOLS.has(toolName)) {
            return { approved: false, reason: `Blocked by --plan mode: ${toolName}` };
        }

        // Auto-approve reads
        if (!WRITE_TOOLS.has(toolName) && !requireApproval) {
            return { approved: true };
        }

        // --yes flag or 'a' was pressed
        if (this.autoApprove || this.approveAll) {
            return { approved: true };
        }

        // 't' was pressed for this tool type
        if (this.approvedToolTypes.has(toolName)) {
            return { approved: true };
        }

        // Interactive prompt
        return this._prompt(toolName, args);
    }

    async _prompt(toolName, args) {
        const argsStr = JSON.stringify(args, null, 2);
        const preview = argsStr.length > 200 ? argsStr.slice(0, 200) + '...' : argsStr;

        process.stderr.write(`\n\x1b[1m┌─ ${toolName} ─────────────────────────────────\x1b[0m\n`);
        process.stderr.write(`\x1b[2m${preview}\x1b[0m\n`);
        process.stderr.write(`\x1b[1m└────────────────────────────────────────────\x1b[0m\n`);
        process.stderr.write(`Allow? [\x1b[1mY\x1b[0m]es / [n]o / [v]iew / [a]ll / [t]ool type: `);

        const answer = await this._readChar();

        switch (answer.toLowerCase()) {
            case 'y': case '': case '\r': case '\n':
                process.stderr.write('Yes\n');
                return { approved: true };
            case 'n':
                process.stderr.write('No\n');
                return { approved: false, reason: 'User rejected' };
            case 'v':
                process.stderr.write('View\n');
                process.stderr.write(`\n\x1b[2m${argsStr}\x1b[0m\n`);
                return this._prompt(toolName, args); // re-prompt after view
            case 'a':
                process.stderr.write('All (auto-approve remaining)\n');
                this.approveAll = true;
                return { approved: true };
            case 't':
                process.stderr.write(`Tool type (auto-approve all ${toolName})\n`);
                this.approvedToolTypes.add(toolName);
                return { approved: true };
            default:
                process.stderr.write('\n');
                return this._prompt(toolName, args);
        }
    }

    _readChar() {
        return new Promise((resolve) => {
            if (!process.stdin.isTTY) {
                resolve('y'); // non-interactive: auto-approve
                return;
            }
            const wasRaw = process.stdin.isRaw;
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once('data', (data) => {
                process.stdin.setRawMode(wasRaw);
                process.stdin.pause();
                const char = data.toString();
                if (char === '\x03') { // Ctrl+C
                    process.exit(0);
                }
                resolve(char);
            });
        });
    }
}
