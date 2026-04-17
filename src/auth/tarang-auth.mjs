/**
 * Orca Authentication — GitHub OAuth + config management.
 * Reads/writes ~/.orca/config.json (shared with Python CLI).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { getLoginSuccessHTML } from '../ui/banner.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';

const CONFIG_DIR = path.join(os.homedir(), '.orca');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export class TarangAuth {
    constructor() {
        this._config = null;
    }

    /** Ensure ~/.orca/ directory exists with secure permissions. */
    _ensureConfigDir() {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
        }
    }

    /** Load credentials from config.json. */
    loadCredentials() {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
                this._config = JSON.parse(raw);
            } else {
                this._config = {};
            }
        } catch {
            this._config = {};
        }
        return {
            token: this._config.token || null,
            openRouterKey: this._config.openrouter_key || null,
            backendUrl: resolveBackendUrl(),
            mode: this._config.mode || 'auto',
            anthropicKey: this._config.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null,
        };
    }

    /** Save credentials atomically (temp-file + rename). */
    saveCredentials(updates) {
        this._ensureConfigDir();
        const current = this._config || {};
        const merged = { ...current, ...updates };
        const tmpPath = `${CONFIG_PATH}.tmp.${process.pid}`;
        fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
        fs.renameSync(tmpPath, CONFIG_PATH);
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

    /** Save OpenRouter API key. */
    saveOpenRouterKey(key) {
        if (!key.startsWith('sk-or-')) {
            throw new Error('Invalid OpenRouter key format. Expected sk-or-...');
        }
        this.saveCredentials({ openrouter_key: key });
    }

    /** Save Anthropic API key. */
    saveAnthropicKey(key) {
        if (!key.startsWith('sk-ant-')) {
            throw new Error('Invalid Anthropic key format. Expected sk-ant-...');
        }
        this.saveCredentials({ anthropic_api_key: key });
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

        process.stderr.write(`\n${BOLD}Orca Configuration${RESET}\n`);
        process.stderr.write(`${'─'.repeat(50)}\n`);
        process.stderr.write(`  Auth:           ${creds.token ? `${check} logged in` : `${cross} not logged in ${DIM}(/login)${RESET}`}\n`);
        process.stderr.write(`  Environment:    ${DIM}${env}${RESET}\n`);
        process.stderr.write(`  Backend:        ${DIM}${creds.backendUrl}${RESET}\n`);
        process.stderr.write(`  Mode:           ${DIM}${creds.mode || 'auto'}${RESET}\n`);
        process.stderr.write(`\n  ${DIM}Models and providers are configured in the browser.${RESET}\n`);
        process.stderr.write(`  ${DIM}Run ${RESET}${CYAN}/config${RESET}${DIM} to open settings.${RESET}\n`);
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
     *   6. CLI receives token, saves to ~/.orca/config.json
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
