/**
 * Backend URL resolver — auto-detects the correct backend based on environment.
 *
 * Priority:
 *   1. TARANG_BACKEND_URL env var (explicit override, for dev/admin testing)
 *   2. TARANG_ENV or NODE_ENV → mapped to known URLs
 *   3. Default: production
 */

const BACKEND_URLS = {
    local:       'http://127.0.0.1:8000',
    development: 'https://tarang-backend-development.up.railway.app',
    production:  'https://tarang-backend-intl-web-app-production.up.railway.app',
};

// Aliases
BACKEND_URLS.dev = BACKEND_URLS.development;
BACKEND_URLS.prod = BACKEND_URLS.production;

const WEB_URLS = {
    local:       'http://localhost:3000',
    development: 'https://codekepler.ai',
    production:  'https://codekepler.ai',
};
WEB_URLS.dev = WEB_URLS.development;
WEB_URLS.prod = WEB_URLS.production;

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
