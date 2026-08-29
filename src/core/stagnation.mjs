export const DEFAULT_STAGNATION_THRESHOLD = 3;
const NO_CHANGE_EDIT_TOOLS = new Set(['edit_file']);

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map(key => [key, canonicalize(value[key])]),
        );
    }
    return value;
}

function editTarget(input = {}, result = {}) {
    return String(
        input.file_path || input.path || result.file_path || result.path || '',
    ).trim();
}

function isNoChangeEdit(tool, result = {}) {
    if (!NO_CHANGE_EDIT_TOOLS.has(tool)) return false;
    if (!result || typeof result !== 'object') return false;
    if (result._no_change || result.no_change) return true;
    if (
        result.success !== false
        && result.lines_added === 0
        && result.lines_removed === 0
    ) {
        return true;
    }
    return false;
}

export function createStagnationTracker({
    enabled = true,
    threshold = DEFAULT_STAGNATION_THRESHOLD,
} = {}) {
    const effectiveThreshold = Number.isInteger(threshold) && threshold >= 2
        ? threshold
        : DEFAULT_STAGNATION_THRESHOLD;
    let previousSignature = null;
    let consecutiveCount = 0;
    let previousResultSignature = null;
    let consecutiveResultCount = 0;

    return {
        record(tool, input) {
            if (!enabled) return { detected: false, count: 0 };

            const signature = JSON.stringify({
                tool,
                input: canonicalize(input || {}),
            });
            if (signature === previousSignature) {
                consecutiveCount++;
            } else {
                previousSignature = signature;
                consecutiveCount = 1;
            }

            return {
                detected: consecutiveCount >= effectiveThreshold,
                count: consecutiveCount,
            };
        },

        recordResult(tool, input, result) {
            if (!enabled) return { detected: false, count: 0 };
            if (!isNoChangeEdit(tool, result)) {
                previousResultSignature = null;
                consecutiveResultCount = 0;
                return { detected: false, count: 0 };
            }

            const target = editTarget(input, result);
            const signature = JSON.stringify({
                kind: 'no_change_edit',
                tool,
                target,
            });
            if (signature === previousResultSignature) {
                consecutiveResultCount++;
            } else {
                previousResultSignature = signature;
                consecutiveResultCount = 1;
            }

            return {
                detected: consecutiveResultCount >= effectiveThreshold,
                count: consecutiveResultCount,
                kind: 'no_change_edit',
                target,
            };
        },

        reset() {
            previousSignature = null;
            consecutiveCount = 0;
            previousResultSignature = null;
            consecutiveResultCount = 0;
        },
    };
}

export function stagnationMessage(tool, count, details = {}) {
    if (details.kind === 'no_change_edit') {
        const target = details.target ? ` for "${details.target}"` : '';
        return `STAGNATION WARNING: Tool "${tool}" made no file changes ${count} consecutive times${target}. ` +
            `The duplicate edit loop was stopped. Re-read the target range, compare the current file content, ` +
            `change the edit strategy, or finish the task.`;
    }
    return `STAGNATION WARNING: Tool "${tool}" was called ${count} consecutive times ` +
        `with identical arguments. The duplicate call was skipped. Review the previous ` +
        `result, change the arguments, try another tool, or finish the task.`;
}
