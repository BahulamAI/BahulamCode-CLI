/**
 * Backend URL resolver — auto-detects the correct backend based on environment.
 *
 * Priority:
 *   1. TARANG_BACKEND_URL env var (explicit override, for dev/admin testing)
 *   2. TARANG_ENV or NODE_ENV → mapped to known URLs
 *   3. Default: production
 */

const BACKEND_URLS = {
    // Four supported environments:
    //   local     — Docker Compose backend on the developer's own machine.
    //   dev       — Bahulam Cloud development (Azure Container Apps, eastus).
    //   production — Bahulam Cloud live (Azure Container Apps, centralus).
    //   bundled   — CLI-local Python runtime spawned as a subprocess. URL is
    //               overridden by bundled-runtime.mjs at spawn time; sentinel
    //               value below is only used if the runtime isn't up yet.
    local:       'http://127.0.0.1:8150',
    dev:         'https://codekepler-backend-dev.kindisland-9034322d.eastus.azurecontainerapps.io',
    production:  'https://api.bahulam.ai',
    bundled:     'http://127.0.0.1:0',   // sentinel — real URL comes from bundled-runtime.mjs
};

// Aliases (backwards compat + convenience)
BACKEND_URLS.prod    = BACKEND_URLS.production;
BACKEND_URLS.treetop = BACKEND_URLS.dev;             // legacy alias
BACKEND_URLS.docker  = BACKEND_URLS.local;           // convenience alias

const WEB_URLS = {
    local:       'http://localhost:3100',
    dev:         'https://treetop.bahulam.ai',
    production:  'https://bahulam.ai',
    bundled:     'http://localhost:3100',   // bundled mode reuses local web if user runs it
};
WEB_URLS.prod    = WEB_URLS.production;
WEB_URLS.treetop = WEB_URLS.dev;             // legacy alias
WEB_URLS.docker  = WEB_URLS.local;

/**
 * Resolve the web dashboard URL from environment.
 * @returns {string}
 */
export function resolveWebUrl() {
    if (process.env.TARANG_WEB_URL) {
        return process.env.TARANG_WEB_URL.replace(/\/$/, '');
    }
    const env = (process.env.TARANG_ENV || process.env.NODE_ENV || 'production').toLowerCase();
    return WEB_URLS[env] || WEB_URLS.production;
}

/**
 * Resolve the backend URL from environment.
 * @returns {string}
 */
export function resolveBackendUrl() {
    // 1. Explicit env var override (for dev/admin testing)
    if (process.env.TARANG_BACKEND_URL) {
        return process.env.TARANG_BACKEND_URL.replace(/\/$/, '');
    }

    // 2. Environment-based detection
    const env = (process.env.TARANG_ENV || process.env.NODE_ENV || 'production').toLowerCase();
    const url = BACKEND_URLS[env];
    if (url) return url;

    // 3. Fallback to production
    return BACKEND_URLS.production;
}
