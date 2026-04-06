/**
 * Mode Selector — T19: --local/--remote/--auto with smart selection.
 */

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
    // Explicit flag
    if (options.local) return 'local';
    if (options.remote) return 'remote';

    // Config default
    const defaultMode = config.mode || 'auto';
    if (defaultMode !== 'auto') return defaultMode;

    // Backend probe
    const backendAvailable = await probeBackend(config.backendUrl || config.backend_url);
    if (!backendAvailable) return 'local';

    // Task classification
    const complexity = classifyTask(instruction);
    if (complexity === 'simple') return 'local';
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
