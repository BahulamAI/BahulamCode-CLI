/**
 * Mode Selector
 *
 * remote (default): All requests go to Tarang backend.
 *   Backend handles orchestration, model selection, tool routing.
 *   User's provider and models configured via web Settings page.
 *
 * local: For local LLMs (Ollama, LM Studio, etc.)
 *   Direct API call, no backend. Only when user explicitly opts in.
 */

let _probeCache = { available: null, timestamp: 0 };
const PROBE_CACHE_TTL = 60_000; // 60s

export async function selectMode(instruction, options, config) {
    // Explicit --local flag: user wants local LLM
    if (options.local) return 'local';

    // Everything else goes to the backend
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
