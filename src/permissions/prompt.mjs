/**
 * Permission Prompts — interactive yes/no for dangerous operations.
 *
 * Used in "default" permission mode to ask the user before executing
 * potentially dangerous tool calls (Bash, Edit, Write, Agent).
 */

/**
 * Prompt the user for permission to execute a tool.
 * @param {string} toolName - tool being invoked
 * @param {object} input - tool input
 * @param {object} rl - readline interface with .question()
 * @returns {Promise<boolean>} true if allowed
 */
export async function promptPermission(toolName, input, rl) {
    if (!rl || typeof rl.question !== 'function') {
        // No readline available — deny by default
        return false;
    }

    const summary = formatToolSummary(toolName, input);
    return new Promise(resolve => {
        rl.question(`Allow ${summary}? [y/N] `, answer => {
            resolve(answer.trim().toLowerCase() === 'y');
        });
    });
}

/**
 * Format a human-readable summary of a tool call.
 * @param {string} toolName
 * @param {object} input
 * @returns {string}
 */
export function formatToolSummary(toolName, input) {
    switch (toolName) {
        case 'Bash':
            return `Bash: ${truncate(input.command || '', 60)}`;
        case 'Edit':
            return `Edit: ${input.file_path || 'unknown file'}`;
        case 'Write':
            return `Write: ${input.file_path || 'unknown file'} (${(input.content || '').length} chars)`;
        case 'MultiEdit':
            return `MultiEdit: ${input.file_path || 'unknown file'} (${(input.edits || []).length} edits)`;
        case 'Agent':
            return `Agent: ${truncate(input.prompt || '', 40)}`;
        case 'WebFetch':
            return `WebFetch: ${truncate(input.url || '', 50)}`;
        case 'RemoteTrigger':
            return `RemoteTrigger: ${input.url || 'unknown'}`;
        default:
            return `${toolName}`;
    }
}

/**
 * Check if a tool requires interactive permission in default mode.
 * Read-only tools are always allowed.
 * @param {string} toolName
 * @returns {boolean}
 */
export function requiresPermission(toolName) {
    const SAFE_TOOLS = new Set([
        'Read', 'Glob', 'Grep', 'LS', 'ToolSearch',
        'AskUser', 'CronList', 'TodoWrite',
    ]);
    return !SAFE_TOOLS.has(toolName);
}

function truncate(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
}
