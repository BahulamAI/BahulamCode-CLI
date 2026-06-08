/**
 * Settings Sync — fetch user settings from Tarang web and cache locally.
 *
 * Syncs: gateway_type, model preferences, configured providers.
 * Cached in ~/.kepler/config.json alongside auth token.
 */

import { resolveWebUrl } from './backend-url.mjs';

/**
 * Fetch user settings from the web API using CLI token.
 * @param {string} token - CLI auth token (kepler_xxx)
 * @returns {Promise<Object|null>} Settings object or null on failure
 */
export async function fetchRemoteSettings(token) {
    if (!token) return null;

    const webUrl = resolveWebUrl();
    const url = `${webUrl}/api/cli/settings`;

    try {
        const resp = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(10_000),
        });

        if (!resp.ok) {
            if (resp.status === 401) {
                process.stderr.write('\x1b[33mSettings sync: token expired or invalid. Run `kepler login` to re-authenticate.\x1b[0m\n');
            }
            return null;
        }

        return await resp.json();
    } catch (err) {
        // Network error — silently fail, use cached settings
        return null;
    }
}

/**
 * Merge remote settings into local config.
 * Remote settings override local only for fields that are set.
 * @param {Object} localConfig - Current ~/.kepler/config.json content
 * @param {Object} remote - Settings from fetchRemoteSettings()
 * @returns {Object} Merged config to save
 */
export function mergeRemoteSettings(localConfig, remote) {
    if (!remote) return localConfig;

    const merged = { ...localConfig };

    // Gateway type
    if (remote.gateway_type) {
        merged.gateway_type = remote.gateway_type;
    }

    // Model preferences
    if (remote.models) {
        merged.models = {
            ...(merged.models || {}),
            ...Object.fromEntries(
                Object.entries(remote.models).filter(([, v]) => v != null)
            ),
        };
    }

    // Configured providers list (informational)
    if (remote.configured_providers) {
        merged.configured_providers = remote.configured_providers;
    }

    // Gateway config (non-secret, e.g. azure endpoint, aws region)
    if (remote.gateway_config && Object.keys(remote.gateway_config).length > 0) {
        merged.gateway_config = remote.gateway_config;
    }

    // Timestamp
    merged.last_synced_at = new Date().toISOString();

    return merged;
}
