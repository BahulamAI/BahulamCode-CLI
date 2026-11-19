/**
 * Mode Selector
 *
 * remote (default): All requests go to Bahulam backend.
 *   Backend handles orchestration, model selection, tool routing.
 *   User's provider and models configured via web Settings page.
 *
 * local: For local LLMs (Ollama, LM Studio, etc.)
 *   Direct API call, no backend. Only when user explicitly opts in.
 */

// Task-shape heuristics. Kept because classifyTask() is a public surface even
// though the remote-first router no longer consults it; deleting the patterns
// without deleting the function turned the export into a runtime ReferenceError
// that no syntax check could catch.
const SIMPLE_PATTERNS = [
    /\b(explain|describe|read|show|list|what is|how does|tell me|summarize)\b/i,
];
const COMPLEX_PATTERNS = [
    /\b(add|create|implement|build|design|architect|migrate|refactor)\b/i,
    /\b(authentication|system|framework|platform|infrastructure|database)\b/i,
];

let _probeCache = { available: null, timestamp: 0 };
const PROBE_CACHE_TTL = 60_000; // 60s

export async function selectMode(instruction, options, config) {
    // Explicit flags always win: the user asked for this route by name.
    if (options.local) return 'local';
    if (options.remote) return 'remote';

    // An explicitly configured mode is a user decision. Ignoring it was the
    // bug: this function takes `config` and silently discarded it, so a user
    // who set mode=local still got the backend. Remote-first is the *default*,
    // not an override of explicit config.
    const configured = config?.mode;
    if (configured === 'local') return 'local';
    if (configured === 'remote') return 'remote';

    // 'auto': follow the backend, but degrade to local when it is unreachable
    // rather than stranding the user on a route that cannot answer.
    if (configured === 'auto') {
        const available = await probeBackend(config?.backendUrl);
        return available ? 'remote' : 'local';
    }

    // Remote-first default for everything else.
    return 'remote';
}

export async function probeBackend(url) {
    if (!url) return false;
    const now = Date.now();
    if (_probeCache.available !== null && (now - _probeCache.timestamp) < PROBE_CACHE_TTL) {
        return _probeCache.available;
    }
    try {
        const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
        _probeCache = { available: resp.ok, timestamp: now };
        return resp.ok;
    } catch {
        _probeCache = { available: false, timestamp: now };
        return false;
    }
}

export function classifyTask(instruction) {
    if (!instruction) return 'simple';
    const isSimple = SIMPLE_PATTERNS.some(p => p.test(instruction));
    const isComplex = COMPLEX_PATTERNS.some(p => p.test(instruction));
    if (isComplex && !isSimple) return 'complex';
    if (isSimple && !isComplex) return 'simple';
    return 'medium'; // ambiguous → default to remote when available
}

/** Reset probe cache (for testing). */
export function resetProbeCache() {
    _probeCache = { available: null, timestamp: 0 };
}
