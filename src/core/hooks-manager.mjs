/**
 * Hooks Manager — T22: PreToolUse/PostToolUse hooks from config.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export class HooksManager {
    constructor(projectDir = process.cwd()) {
        this.projectHooksPath = path.join(projectDir, '.tarang', 'hooks.json');
        this.globalHooksPath = path.join(process.env.HOME || '', '.tarang', 'hooks.json');
        this.hooks = this._loadHooks();
        this.firedHooks = [];
    }

    _loadHooks() {
        const hooks = { PreToolUse: [], PostToolUse: [] };

        // Global hooks (lower priority)
        try {
            if (fs.existsSync(this.globalHooksPath)) {
                const global = JSON.parse(fs.readFileSync(this.globalHooksPath, 'utf-8'));
                if (global.PreToolUse) hooks.PreToolUse.push(...global.PreToolUse);
                if (global.PostToolUse) hooks.PostToolUse.push(...global.PostToolUse);
            }
        } catch { /* skip corrupt */ }

        // Project hooks (higher priority, appended after global)
        try {
            if (fs.existsSync(this.projectHooksPath)) {
                const project = JSON.parse(fs.readFileSync(this.projectHooksPath, 'utf-8'));
                if (project.PreToolUse) hooks.PreToolUse.push(...project.PreToolUse);
                if (project.PostToolUse) hooks.PostToolUse.push(...project.PostToolUse);
            }
        } catch { /* skip corrupt */ }

        return hooks;
    }

    /** Run PreToolUse hooks. Returns { allowed, message }. */
    runPreToolUse(toolName, toolInput) {
        return this._runHooks('PreToolUse', toolName, toolInput);
    }

    /** Run PostToolUse hooks. Returns { success }. */
    runPostToolUse(toolName, toolInput, result) {
        return this._runHooks('PostToolUse', toolName, toolInput, result);
    }

    _runHooks(event, toolName, toolInput, result = null) {
        const hooks = (this.hooks[event] || []).filter(h => !h.tool || h.tool === toolName);
        for (const hook of hooks) {
            try {
                const env = {
                    ...process.env,
                    HOOK_EVENT: event,
                    TOOL_NAME: toolName,
                    TOOL_INPUT: JSON.stringify(toolInput),
                    FILE_PATH: toolInput?.path || toolInput?.file_path || '',
                };
                if (result) env.TOOL_RESULT = JSON.stringify(result);

                execSync(hook.command, { env, stdio: 'pipe', timeout: 10_000 });
                this.firedHooks.push({ event, tool: toolName, command: hook.command, success: true });
            } catch (err) {
                this.firedHooks.push({ event, tool: toolName, command: hook.command, success: false });
                if (event === 'PreToolUse') {
                    return { allowed: false, message: `Hook blocked ${toolName}: ${err.message}` };
                }
            }
        }
        return { allowed: true, success: true };
    }

    /** List configured hooks. */
    listHooks() { return this.hooks; }

    /** List hooks that fired this session. */
    getFiredHooks() { return this.firedHooks; }

    /** Check if any hooks are configured. */
    hasHooks() {
        return (this.hooks.PreToolUse.length + this.hooks.PostToolUse.length) > 0;
    }
}
