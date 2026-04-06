/**
 * Telemetry Stub — basic telemetry interface (no actual reporting).
 *
 * Logs events to debug output when CLAUDE_CODE_DEBUG is set.
 * Designed to be a drop-in interface for the full telemetry system.
 */

const events = [];
let enabled = true;

/**
 * Track a telemetry event.
 * @param {string} event - event name
 * @param {object} [properties] - event properties
 */
export function track(event, properties = {}) {
    if (!enabled) return;
    if (process.env.CLAUDE_CODE_DISABLE_TELEMETRY === '1') return;

    const entry = {
        event,
        properties,
        timestamp: Date.now(),
    };

    events.push(entry);

    // Keep max 1000 events in memory
    if (events.length > 1000) {
        events.splice(0, events.length - 1000);
    }

    if (process.env.CLAUDE_CODE_DEBUG) {
        console.error(`[telemetry] ${event}`, JSON.stringify(properties).slice(0, 200));
    }
}

/**
 * Track a timing event.
 * @param {string} event - event name
 * @param {number} durationMs - duration in milliseconds
 * @param {object} [properties] - additional properties
 */
export function trackTiming(event, durationMs, properties = {}) {
    track(event, { ...properties, durationMs });
}

/**
 * Track an error.
 * @param {string} event - error context
 * @param {Error} error - the error
 */
export function trackError(event, error) {
    track(`error.${event}`, {
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 3).join('\n'),
    });
}

/**
 * Get collected events (for debugging).
 * @returns {Array}
 */
export function getEvents() {
    return [...events];
}

/**
 * Clear collected events.
 */
export function clear() {
    events.length = 0;
}

/**
 * Enable or disable telemetry.
 * @param {boolean} value
 */
export function setEnabled(value) {
    enabled = value;
}

/**
 * Get telemetry stats.
 */
export function getStats() {
    const counts = {};
    for (const e of events) {
        counts[e.event] = (counts[e.event] || 0) + 1;
    }
    return {
        totalEvents: events.length,
        enabled,
        eventCounts: counts,
    };
}
