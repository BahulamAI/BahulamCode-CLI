/**
 * Tarang Authentication — GitHub OAuth + config management.
 * Reads/writes ~/.tarang/config.json (shared with Python CLI).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { getLoginSuccessHTML } from '../ui/banner.mjs';

const CONFIG_DIR = path.join(os.homedir(), '.tarang');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export class TarangAuth {
    constructor() {
        this._config = null;
    }

    /** Ensure ~/.tarang/ directory exists with secure permissions. */
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
            backendUrl: this._config.backend_url || 'https://tarang-backend-intl-web-app-production.up.railway.app',
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

    /** Set custom backend URL. */
    setBackendUrl(url) {
        try {
            new URL(url);
        } catch {
            throw new Error(`Invalid URL: ${url}`);
        }
        this.saveCredentials({ backend_url: url });
    }

    /** Display config with masked secrets (styled). */
    printConfig() {
        const creds = this.loadCredentials();
        const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
        const mask = (val) => {
            if (!val) return `${RED}\u2717 not set${RESET}`;
            if (val.length <= 8) return `${GREEN}\u2713 ****${RESET}`;
            return `${GREEN}\u2713${RESET} ${val.slice(0, 6)}...${val.slice(-4)}`;
        };
        process.stderr.write(`\n${BOLD}Tarang Configuration${RESET} ${DIM}(~/.tarang/config.json)${RESET}\n`);
        process.stderr.write(`${'─'.repeat(50)}\n`);
        process.stderr.write(`  Token:          ${mask(creds.token)}\n`);
        process.stderr.write(`  OpenRouter:     ${mask(creds.openRouterKey)}\n`);
        process.stderr.write(`  Anthropic:      ${mask(creds.anthropicKey)}\n`);
        process.stderr.write(`  Backend URL:    ${DIM}${creds.backendUrl || '(default)'}${RESET}\n`);
        process.stderr.write(`  Mode:           ${DIM}${creds.mode || 'auto'}${RESET}\n`);
        process.stderr.write('\n');
    }

    /**
     * Run GitHub OAuth login flow.
     * Opens browser, starts local callback server, exchanges code for token.
     * @param {string} backendUrl
     */
    async login(backendUrl) {
        const base = backendUrl || this.loadCredentials().backendUrl;

        // Check if backend is reachable
        try {
            process.stderr.write('\x1b[2mConnecting to Tarang backend...\x1b[0m\n');
            const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
            if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
            process.stderr.write('\x1b[32m✓ Backend reachable\x1b[0m\n');
        } catch (err) {
            process.stderr.write(`\x1b[31m✗ Cannot reach Tarang backend at ${base}\x1b[0m\n`);
            process.stderr.write(`  \x1b[2m${err.message}\x1b[0m\n`);
            process.stderr.write('\x1b[33mSet a custom URL with:\x1b[0m tarang config --backend-url URL\n');
            process.exit(1);
        }

        return new Promise((resolve, reject) => {
            const server = http.createServer(async (req, res) => {
                const url = new URL(req.url, `http://localhost`);
                const code = url.searchParams.get('code');

                if (!code) {
                    res.writeHead(400);
                    res.end('Missing code parameter');
                    return;
                }

                try {
                    // Exchange code for token via backend
                    const tokenResp = await fetch(`${base}/auth/callback?code=${code}`);
                    if (!tokenResp.ok) throw new Error(`Token exchange failed: ${tokenResp.status}`);
                    const data = await tokenResp.json();

                    this.saveCredentials({ token: data.access_token || data.token });

                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(getLoginSuccessHTML());

                    server.close();
                    resolve(true);
                } catch (err) {
                    res.writeHead(500);
                    res.end(`Login failed: ${err.message}`);
                    server.close();
                    reject(err);
                }
            });

            server.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                const redirectUri = `http://127.0.0.1:${port}/callback`;
                const authUrl = `${base}/auth/login?redirect_uri=${encodeURIComponent(redirectUri)}`;

                process.stderr.write(`\n\x1b[36mOpening browser for GitHub login...\x1b[0m\n`);
                process.stderr.write(`\x1b[2mIf browser doesn't open, visit:\x1b[0m\n  \x1b[4m${authUrl}\x1b[0m\n\n`);

                // Open browser (platform-specific)
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
     * @param {string} backendUrl
     */
    async ensureAuth(backendUrl) {
        if (!this.isAuthenticated()) {
            process.stderr.write('\x1b[33mNot logged in.\x1b[0m Starting login flow...\n');
            await this.login(backendUrl);
        }
    }
}
