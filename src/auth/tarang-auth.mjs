/**
 * Bahulam Code Authentication — GitHub OAuth + config management.
 * Reads/writes ~/.bahulam/config.json (fallback: ~/.kepler/config.json for
 * legacy installs — see src/core/paths.mjs for the resolver).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { getLoginSuccessHTML } from '../ui/banner.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';
import { bahulamHome } from '../core/paths.mjs';

// Note: computed via a function (not a constant) so that BAHULAM_HOME /
// KEPLER_HOME env-var swaps mid-process still work.
function configDir() { return bahulamHome(); }
function configPath() { return path.join(configDir(), 'config.json'); }

// Legacy exports kept for backwards compat with any tests/scripts that
// still import CONFIG_DIR / CONFIG_PATH by name.
const CONFIG_DIR = configDir();
const CONFIG_PATH = configPath();

let _tokenEnvNoticeShown = false;
function readTokenFromEnv() {
    if (process.env.B0_TOKEN) return process.env.B0_TOKEN;
    if (process.env.KEPLER_TOKEN) {
        if (!_tokenEnvNoticeShown && process.env.B0_QUIET_MIGRATION !== '1') {
            _tokenEnvNoticeShown = true;
            try {
                process.stderr.write(
                    '  \x1b[2mnote: KEPLER_TOKEN is deprecated; set B0_TOKEN instead.\x1b[0m\n'
                );
            } catch {}
        }
        return process.env.KEPLER_TOKEN;
    }
    return null;
}

export class TarangAuth {
    constructor() {
        this._config = null;
    }

    /** Ensure ~/.bahulam/ (or legacy ~/.kepler/) exists with secure permissions. */
    _ensureConfigDir() {
        const dir = configDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
    }

    /** Load credentials and settings from config.json. */
    loadCredentials() {
        const cfgPath = configPath();
        try {
            if (fs.existsSync(cfgPath)) {
                const raw = fs.readFileSync(cfgPath, 'utf-8');
                this._config = JSON.parse(raw);
            } else {
                this._config = {};
            }
        } catch {
            this._config = {};
        }
        return {
            token: readTokenFromEnv() || this._config.token || null,
            openRouterKey: this._config.openrouter_key || process.env.OPENROUTER_API_KEY || null,
            anthropicKey: this._config.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null,
            openaiKey: this._config.openai_api_key || process.env.OPENAI_API_KEY || null,
            googleKey: this._config.google_api_key || process.env.GOOGLE_API_KEY || null,
            backendUrl: resolveBackendUrl(),
            mode: this._config.mode || 'auto',
            gatewayType: this._config.gateway_type || 'openrouter',
            models: this._config.models || {},
            configuredProviders: this._config.configured_providers || [],
            gatewayConfig: this._config.gateway_config || {},
            // PRD-076 W7: persisted /model picks. `modelConfig` mirrors the
            // Python-side key read_local_model_config() looks for; keep the
            // snake_case JSON key so the runtime picks it up unchanged.
            modelConfig: this._config.model_config || {},
            modelMode: this._config.model_mode || null,
            routePreference: this._config.route_preference || null,
        };
    }

    /** Get the raw config object. */
    getRawConfig() {
        if (!this._config) this.loadCredentials();
        return this._config || {};
    }

    /** Clear credentials — remove token and keys from config. */
    logout() {
        try {
            const cfgPath = configPath();
            if (fs.existsSync(cfgPath)) {
                fs.unlinkSync(cfgPath);
            }
            this._config = null;
            return true;
        } catch {
            return false;
        }
    }

    /** Save credentials atomically (temp-file + rename). */
    saveCredentials(updates) {
        this._ensureConfigDir();
        const current = this._config || {};
        const merged = { ...current, ...updates };
        const cfgPath = configPath();
        const tmpPath = `${cfgPath}.tmp.${process.pid}`;
        fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
        fs.renameSync(tmpPath, cfgPath);
        this._config = merged;
    }

    /** Check if user has a valid auth token. */
    isAuthenticated() {
        const creds = this.loadCredentials();
        return !!creds.token;
    }

    /** Check if OpenRouter key is configured. */
    hasOpenRouterKey() {
        const creds = this.loadCredentials();
        return !!creds.openRouterKey;
    }

    /** Save an API key by provider name. */
    saveProviderKey(provider, key) {
        const keyMap = {
            openrouter: 'openrouter_key',
            anthropic: 'anthropic_api_key',
            openai: 'openai_api_key',
            googleai: 'google_api_key',
            azureopenai: 'azure_api_key',
            bedrock: 'aws_access_key',
            databricks: 'databricks_token',
        };
        const field = keyMap[provider];
        if (!field) throw new Error(`Unknown provider: ${provider}`);
        this.saveCredentials({ [field]: key });
    }

    /** Save OpenRouter API key. */
    saveOpenRouterKey(key) {
        this.saveProviderKey('openrouter', key);
    }

    /** Save Anthropic API key. */
    saveAnthropicKey(key) {
        this.saveProviderKey('anthropic', key);
    }

    /** Save OpenAI API key. */
    saveOpenAIKey(key) {
        this.saveProviderKey('openai', key);
    }

    /** Save Google AI API key. */
    saveGoogleKey(key) {
        this.saveProviderKey('googleai', key);
    }

    /** Sync settings from web backend and save locally. */
    async syncSettings() {
        const { fetchRemoteSettings, mergeRemoteSettings } = await import('../core/settings-sync.mjs');
        const creds = this.loadCredentials();
        if (!creds.token) throw new Error('Not logged in. Run `bahulam-code login` first.');

        const remote = await fetchRemoteSettings(creds.token);
        if (!remote) throw new Error('Failed to fetch settings from server.');

        const merged = mergeRemoteSettings(this.getRawConfig(), remote);
        this.saveCredentials(merged);
        return remote;
    }

    /** Set default mode. */
    setMode(mode) {
        const valid = ['local', 'remote', 'auto'];
        if (!valid.includes(mode)) {
            throw new Error(`Invalid mode: ${mode}. Must be one of: ${valid.join(', ')}`);
        }
        this.saveCredentials({ mode });
    }

    /** Display config (styled). */
    printConfig() {
        const creds = this.loadCredentials();
        const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
        const check = `${GREEN}\u2713${RESET}`;
        const cross = `${RED}\u2717${RESET}`;

        const env = process.env.TARANG_ENV || process.env.NODE_ENV || 'production';

        process.stderr.write(`\n${BOLD}Bahulam Code Configuration${RESET}\n`);
        process.stderr.write(`${'─'.repeat(50)}\n`);
        process.stderr.write(`  Auth:           ${creds.token ? `${check} logged in` : `${cross} not logged in ${DIM}(/login)${RESET}`}\n`);
        process.stderr.write(`  Environment:    ${DIM}${env}${RESET}\n`);
        process.stderr.write(`  Backend:        ${DIM}${creds.backendUrl}${RESET}\n`);
        process.stderr.write(`  Mode:           ${DIM}${creds.mode || 'auto'}${RESET}\n`);
        process.stderr.write(`  Gateway:        ${DIM}${creds.gatewayType}${RESET}\n`);

        const models = creds.models || {};
        const planningModel = models.planning || models.orchestrator;
        if (planningModel || models.reasoning || models.local) {
            process.stderr.write(`\n${BOLD}  Models${RESET}\n`);
            if (planningModel)       process.stderr.write(`  Planning:       ${DIM}${planningModel}${RESET}\n`);
            if (models.reasoning)    process.stderr.write(`  Coding:         ${DIM}${models.reasoning}${RESET}\n`);
            if (models.local)        process.stderr.write(`  Local:          ${DIM}${models.local}${RESET}\n`);
        }

        const providers = creds.configuredProviders || [];
        if (providers.length > 0) {
            process.stderr.write(`  Providers:      ${DIM}${providers.join(', ')}${RESET}\n`);
        }

        const raw = this.getRawConfig();
        if (raw.last_synced_at) {
            process.stderr.write(`  Last synced:    ${DIM}${new Date(raw.last_synced_at).toLocaleString()}${RESET}\n`);
        }

        process.stderr.write(`\n  ${DIM}Run ${RESET}${CYAN}bahulam-code sync${RESET}${DIM} to sync settings from web.${RESET}\n`);
        process.stderr.write(`  ${DIM}Run ${RESET}${CYAN}bahulam-code configure${RESET}${DIM} to open settings in browser.${RESET}\n`);
        process.stderr.write('\n');
    }

    /**
     * Run login flow via web app.
     *
     * Flow:
     *   1. CLI starts local HTTP server on random port
     *   2. Opens browser to web /auth/cli?callback=http://127.0.0.1:{port}/callback
     *   3. Web checks Supabase session (if none → GitHub OAuth → Supabase)
     *   4. Web generates CLI token via /api/cli/token
     *   5. Web redirects browser to CLI callback with token
     *   6. CLI receives token, saves to ~/.bahulam/config.json
     */
    async login() {
        const { resolveWebUrl } = await import('../core/backend-url.mjs');
        const webUrl = resolveWebUrl();

        return new Promise((resolve, reject) => {
            const server = http.createServer(async (req, res) => {
                const url = new URL(req.url, `http://localhost`);

                // The web app redirects here with ?token=<cli_token>
                const token = url.searchParams.get('token');

                if (!token) {
                    // Maybe an error or missing token
                    const error = url.searchParams.get('error');
                    if (error) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(`<html><body><h2>Login failed</h2><p>${error}</p></body></html>`);
                        server.close();
                        reject(new Error(error));
                        return;
                    }
                    // Ignore other requests (favicon, etc.)
                    res.writeHead(200);
                    res.end('');
                    return;
                }

                // Save the CLI token
                this.saveCredentials({ token });

                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(getLoginSuccessHTML());

                server.close();
                resolve(true);
            });

            server.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                const callbackUrl = `http://127.0.0.1:${port}/callback`;
                const authUrl = `${webUrl}/auth/cli?callback=${encodeURIComponent(callbackUrl)}`;

                process.stderr.write(`\n\x1b[36mOpening browser for login...\x1b[0m\n`);
                process.stderr.write(`\x1b[2mIf browser doesn't open, visit:\x1b[0m\n  \x1b[4m${authUrl}\x1b[0m\n\n`);

                // Open browser
                const openCmd = process.platform === 'darwin' ? 'open' :
                                process.platform === 'win32' ? 'start' : 'xdg-open';
                import('node:child_process').then(({ exec }) => {
                    exec(`${openCmd} "${authUrl}"`, () => {});
                });
            });

            // Timeout after 120s
            setTimeout(() => {
                server.close();
                reject(new Error('Login timed out after 120s'));
            }, 120_000);
        });
    }

    /**
     * Ensure user is authenticated, prompt login if not.
     */
    async ensureAuth() {
        if (!this.isAuthenticated()) {
            process.stderr.write('\x1b[33mNot logged in.\x1b[0m Starting login flow...\n');
            await this.login();
        }
    }
}
