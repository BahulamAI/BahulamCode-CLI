import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { bahulamHome } from '../core/paths.mjs';

// Credentials never belong in portable MCP settings. This is a private local
// store, not an encrypted keychain; Windows relies on the user's profile ACL.
export class McpCredentialStore {
    constructor(url, home = bahulamHome()) {
        const identity = new URL(url).href;
        this.directory = path.join(home, 'mcp-credentials');
        this.file = path.join(this.directory, createHash('sha256').update(identity).digest('hex') + '.json');
    }
    read() {
        try {
            const fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            try {
                const stat = fs.fstatSync(fd);
                if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
                    throw new Error('MCP credential file must be private (mode 0600).');
                }
                return JSON.parse(fs.readFileSync(fd, 'utf8'));
            } finally { fs.closeSync(fd); }
        } catch (error) {
            if (error.code === 'ENOENT') return {};
            throw new Error('Cannot read private MCP credentials. Check file permissions or run mcp logout.');
        }
    }
    write(value) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('MCP credential directory must not be a symlink.');
        fs.chmodSync(this.directory, 0o700);
        const temporary = this.file + '.' + randomBytes(12).toString('hex');
        try {
            fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
            fs.renameSync(temporary, this.file);
        } finally { try { fs.unlinkSync(temporary); } catch {} }
    }
    update(patch) { this.write({ ...this.read(), ...patch }); }
    clear() { try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export function resolveMcpConfig(config, environment = process.env) {
    const expand = (value, env) => {
        if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
            if (!env[name]) throw safeMcpError(`Missing MCP environment variable: ${name}`);
            return env[name];
        });
        if (Array.isArray(value)) return value.map(item => expand(item, env));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, env)]));
        return value;
    };
    const localEnv = expand(config.env || {}, environment);
    return expand({ ...config, env: localEnv }, { ...environment, ...localEnv });
}

export function safeMcpUrl(value) {
    try {
        const url = new URL(value);
        // URL paths and queries may themselves contain an API key. Only show
        // known public transport paths; never attempt to guess key entropy.
        const pathname = ['/', '/mcp', '/sse', '/mcp-oauth-dynamic'].includes(url.pathname) ? url.pathname : '/[path hidden]';
        return url.origin + pathname + (url.search ? '?[redacted]' : '');
    } catch { return '[invalid URL]'; }
}

export function redactMcpConfig(config) {
    const reference = value => typeof value === 'string' && /^(?:Bearer |Basic )?\$\{\w+\}$/.test(value) ? value : '[redacted]';
    const result = Object.fromEntries(Object.entries(config).map(([key, value]) => [key,
        ['command', 'args', 'url', 'env', 'headers', 'transport', 'auth', 'disabled'].includes(key) ? value : '[redacted]']));
    if (result.url) result.url = safeMcpUrl(result.url);
    if (result.headers) result.headers = Object.fromEntries(Object.entries(result.headers).map(([key, value]) => [key, reference(value)]));
    if (result.env) result.env = Object.fromEntries(Object.entries(result.env).map(([key, value]) => [key, reference(value)]));
    if (result.args) result.args = result.args.map(reference);
    if (result.auth) result.auth = { type: result.auth.type };
    return result;
}

const safeErrors = new WeakSet();
export function mcpError(error) {
    // Remote error bodies can echo keys, tokens, URLs and request headers.
    // Only locally constructed actionable messages cross this boundary.
    if (safeErrors.has(error)) return error.message;
    const status = Number(error?.code ?? error?.status);
    return `MCP request failed${Number.isInteger(status) && status >= 100 && status < 600 ? ` (HTTP ${status})` : ''}. Check the endpoint and authentication; use bahulam mcp login <name> for OAuth.`;
}

export function safeMcpError(message) {
    const error = new Error(message);
    safeErrors.add(error);
    return error;
}
