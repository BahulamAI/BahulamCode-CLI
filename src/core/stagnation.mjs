export const DEFAULT_STAGNATION_THRESHOLD = 3;

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

export function createStagnationTracker({
    enabled = true,
    threshold = DEFAULT_STAGNATION_THRESHOLD,
} = {}) {
    const effectiveThreshold = Number.isInteger(threshold) && threshold >= 2
        ? threshold
        : DEFAULT_STAGNATION_THRESHOLD;
    let previousSignature = null;
    let consecutiveCount = 0;

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

        reset() {
            previousSignature = null;
            consecutiveCount = 0;
        },
    };
}

export function stagnationMessage(tool, count) {
    return `STAGNATION WARNING: Tool "${tool}" was called ${count} consecutive times ` +
        `with identical arguments. The duplicate call was skipped. Review the previous ` +
        `result, change the arguments, try another tool, or finish the task.`;
}
