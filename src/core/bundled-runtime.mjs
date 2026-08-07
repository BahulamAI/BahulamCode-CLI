/**
 * Bundled Python runtime adapter (PRD-091 §6.3).
 *
 * The Bahulam Code CLI ships with a bundled Python `agent_framework`
 * runtime — the SAME code the cloud/enterprise backend runs. This module
 * spawns that runtime as a subprocess, waits for READY, and provides a
 * `fetch`-like helper for the rest of the CLI to talk to it over a Unix
 * socket.
 *
 * Contract: the runtime speaks the same HTTP/SSE vocabulary the cloud
 * backend does (POST /api/execute, POST /api/callback/{task_id}, POST
 * /api/intervention/{task_id}, GET /healthz). So stream-client.mjs can
 * swap between "local runtime" and "cloud backend" by changing the
 * `baseUrl` — everything else stays identical.
 *
 * Lifecycle:
 *   1. First call to ensureRuntimeReady() spawns bahulam-agent as a
 *      subprocess with a per-session Unix socket path.
 *   2. Waits for /healthz to return {status:'ready'} (up to READY_TIMEOUT_MS).
 *   3. Returns a `socketPath` the caller uses with runtimeFetch().
 *   4. Subsequent calls reuse the warm daemon (no re-spawn cost).
 *   5. Process exit tears down the subprocess cleanly.
 *
 * Fallbacks:
 *   - BAHULAM_JS_AGENT=1 → callers should bypass this module entirely
 *     and use the interim LocalAgent JS class.
 *   - BAHULAM_RUNTIME_ROOT=<path> → override the default install location
 *     (~/.bahulam/runtime/current) for dev/CI.
 *   - Windows: Unix sockets are not universal; falls back to a random
 *     localhost TCP port. The runtime supports --port for this reason.
 *
 * See PRD-090 §4a (Monetization Model) for the three-path routing that
 * lives INSIDE the runtime; this adapter is transport-only.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import * as http from 'node:http';

const DEV_RUNTIME_ROOT = path.join(os.homedir(), '.bahulam', 'runtime', 'current');
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;
const IS_WINDOWS = process.platform === 'win32';

// TCP is the default transport so existing fetch-based call sites in
// stream-client.mjs work unchanged (baseUrl points at http://127.0.0.1:<port>).
// Unix socket is available via BAHULAM_RUNTIME_TRANSPORT=socket for stricter
// isolation but requires an undici dispatcher path for every fetch.
const USE_UNIX_SOCKET = process.env.BAHULAM_RUNTIME_TRANSPORT === 'socket';

let _daemon = null; // { proc, socketPath, port, ready }

// Runtime resolution order (see RUNBOOK in codekepler-bahulam-runtime):
//   1. BAHULAM_RUNTIME_ROOT env — explicit override for dev/testing
//   2. Sibling optional dep — @bahulam/runtime-<platform>-<arch> installed
//      alongside @bahulam/code via npm's optionalDependencies. This is the
//      shipped path for end users. `os`/`cpu` fields in each runtime package
//      ensure npm only installs the matching one.
//   3. Legacy dev tarball — ~/.bahulam/runtime/current/ — used by developers
//      who built the runtime by hand before the npm packaging existed.
function _runtimeRoot() {
  if (process.env.BAHULAM_RUNTIME_ROOT) return process.env.BAHULAM_RUNTIME_ROOT;

  // Sibling optional dep: same package.json's node_modules/@bahulam/runtime-<plat>-<arch>.
  // import.meta.url points at this file inside @bahulam/code, so its
  // node_modules is two dirs up (@bahulam/code/src/core/ → @bahulam/code/ → @bahulam/).
  const plat = process.platform;   // 'darwin' | 'linux' | 'win32'
  const arch = process.arch;       // 'arm64' | 'x64' | ...
  const siblingName = `@bahulam/runtime-${plat}-${arch}`;
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    // Walk up looking for node_modules containing @bahulam/runtime-<plat>-<arch>
    let dir = here;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'node_modules', siblingName);
      if (fs.existsSync(path.join(candidate, 'bin'))) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* fall through */ }

  return DEV_RUNTIME_ROOT;
}

function _runtimeBin() {
  const binDir = path.join(_runtimeRoot(), 'bin');
  if (IS_WINDOWS) {
    // Prefer whichever launcher ships in the Windows runtime package.
    // Current build emits .cmd; keep .exe as a future option.
    for (const name of ['bahulam-agent.cmd', 'bahulam-agent.exe', 'bahulam-agent.bat']) {
      const p = path.join(binDir, name);
      if (fs.existsSync(p)) return p;
    }
    return path.join(binDir, 'bahulam-agent.cmd');
  }
  return path.join(binDir, 'bahulam-agent');
}

// Read the framework LICENSE_KEY from a config file so shipped end-users
// don't have to set an env var. Precedence: env var wins if already set,
// otherwise read ~/.bahulam/license.jwt. Returns null when neither is set.
function _readLicenseKey() {
  if (process.env.LICENSE_KEY) return process.env.LICENSE_KEY;
  const licensePath = path.join(os.homedir(), '.bahulam', 'license.jwt');
  try {
    return fs.readFileSync(licensePath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Read the saved bahulam CLI token from ~/.bahulam/config.json so the
// bundled Python runtime authenticates to gateway.bahulam.ai as the
// logged-in user without the shell having to export BAHULAM_API_KEY.
// Precedence: shell env wins > saved config. Returns null when neither
// is present (framework then errors with an "Not logged in" style message).
function _readCliToken() {
  if (process.env.BAHULAM_API_KEY) return process.env.BAHULAM_API_KEY;
  if (process.env.BAHULAM_CLI_TOKEN) return process.env.BAHULAM_CLI_TOKEN;
  if (process.env.B0_TOKEN) return process.env.B0_TOKEN;
  const configPath = path.join(os.homedir(), '.bahulam', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const token = (parsed && typeof parsed.token === 'string') ? parsed.token.trim() : null;
    return token || null;
  } catch {
    return null;
  }
}

function _newSocketPath() {
  const dir = path.join(os.tmpdir(), 'bahulam-code');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `agent-${randomBytes(4).toString('hex')}.sock`);
}

// Remove the framework's license lock + keychain-shadow so activation
// re-runs fresh on the next import. All calls are best-effort — a missing
// file is fine, a locked keychain is fine.
function _clearLicenseActivationState() {
  const paths = [
    path.join(os.homedir(), '.agent_framework', '.license_lock'),
    // macOS shadow file (see agent_framework/_lockfile.py:_shadow_path)
    path.join(os.homedir(), 'Library', 'Caches', '.com.apple.dt.instruments', '.state'),
  ];
  for (const p of paths) {
    try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
  }
  if (process.platform === 'darwin') {
    try {
      spawnSync('security',
        ['delete-generic-password', '-s', 'com.axplusb.agent.runtime', '-a', 'af_state'],
        { stdio: 'ignore' });
    } catch { /* best-effort */ }
  }
}

/**
 * Health-probe the runtime over Unix socket or TCP.
 * Returns the parsed JSON body or throws on non-2xx / non-JSON.
 */
function _probeHealth({ socketPath, port }) {
  return new Promise((resolve, reject) => {
    const opts = { method: 'GET', path: '/healthz' };
    if (socketPath) {
      opts.socketPath = socketPath;
    } else {
      opts.host = '127.0.0.1';
      opts.port = port;
    }
    const req = http.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`/healthz HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`/healthz body not JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Ensure the bundled runtime is running and healthy.
 * Returns { baseUrl, socketPath, port } for the caller to construct
 * fetch requests against.
 */
export async function ensureRuntimeReady() {
  if (_daemon && _daemon.ready) {
    return _describeDaemon(_daemon);
  }

  const bin = _runtimeBin();
  if (!fs.existsSync(bin)) {
    throw new Error(
      `Bahulam runtime not found at ${bin}. ` +
      `Re-run \`npm install -g @bahulam/code\` to fetch the runtime, ` +
      `or set BAHULAM_RUNTIME_ROOT to a valid install path.`,
    );
  }

  // Transport: default to TCP on 127.0.0.1 so raw `fetch(baseUrl+path)`
  // in stream-client.mjs works unchanged. Unix socket is available under
  // BAHULAM_RUNTIME_TRANSPORT=socket, but callers must then route every
  // request through runtimeFetch() (which uses an undici socket dispatcher).
  // Windows has no Unix sockets so it's always TCP.
  const useSocket = USE_UNIX_SOCKET && !IS_WINDOWS;
  const socketPath = useSocket ? _newSocketPath() : null;
  const port = useSocket ? null : await _pickFreePort();
  const args = socketPath ? ['--socket', socketPath] : ['--port', String(port)];

  const licenseKey = _readLicenseKey();
  const cliToken = _readCliToken();
  // Best-effort: clear stale license-activation state so a fresh env_id
  // gets a fresh binding. Without this, restarts from a different socket
  // or a bumped runtime version can trip the framework's activation guard.
  _clearLicenseActivationState();
  const proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BAHULAM_CLI_LOCAL: '1',
      // Framework validates LICENSE_KEY against the license portal on import.
      // The portal is now embedded inside the Bahulam Gateway itself
      // (see codekepler-bahulam-gateway/app/main.py mount at /portal), so
      // the phone-home shares gateway uptime. Framework code (_license.py)
      // reads LICENSE_PORTAL_URL and hits {url}/api/heartbeat.
      LICENSE_PORTAL_URL: process.env.LICENSE_PORTAL_URL || 'https://gateway.bahulam.ai/portal',
      // Framework requires LICENSE_KEY at import time. Sourced from
      // ~/.bahulam/license.jwt so end users don't need to export a var.
      ...(licenseKey ? { LICENSE_KEY: licenseKey } : {}),
      // Bahulam CLI token from `bahulam login` (saved in
      // ~/.bahulam/config.json). BahulamGateway reads it from any of
      // BAHULAM_API_KEY / BAHULAM_CLI_TOKEN / BAHULAM_GATEWAY_API_KEY —
      // we set both so it works whether the framework prefers one over
      // the other. Shell env wins (see _readCliToken precedence).
      ...(cliToken ? {
        BAHULAM_API_KEY: cliToken,
        BAHULAM_CLI_TOKEN: cliToken,
      } : {}),
    },
    detached: false,
  });

  _daemon = { proc, socketPath, port, ready: false };

  proc.on('exit', (code, signal) => {
    if (_daemon && _daemon.proc === proc) {
      _daemon.ready = false;
      _daemon = null;
    }
    if (code !== 0 && code !== null) {
      process.stderr.write(`  ! bahulam-agent runtime exited (code ${code}, signal ${signal || 'none'})\n`);
    }
  });

  // Surface stderr from the runtime — helps debug spawn / import errors.
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text && process.env.BAHULAM_RUNTIME_DEBUG) {
      process.stderr.write(`  [agent] ${text}\n`);
    }
  });

  // Wait for /healthz to return ready.
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (proc.exitCode !== null) {
      throw new Error(
        `bahulam-agent exited before becoming ready (code ${proc.exitCode}). ` +
        `Re-run with BAHULAM_RUNTIME_DEBUG=1 to see runtime stderr.`,
      );
    }
    if (socketPath && !fs.existsSync(socketPath)) {
      await _sleep(READY_POLL_MS);
      continue;
    }
    try {
      const health = await _probeHealth({ socketPath, port });
      if (health && health.status === 'ready') {
        _daemon.ready = true;
        _daemon.frameworkVersion = health.framework;
        _daemon.runtimeVersion = health.runtime_version;
        return _describeDaemon(_daemon);
      }
    } catch (e) {
      lastErr = e;
    }
    await _sleep(READY_POLL_MS);
  }

  // Timeout — kill and report.
  try { proc.kill('SIGTERM'); } catch {}
  _daemon = null;
  throw new Error(
    `bahulam-agent did not become ready within ${READY_TIMEOUT_MS / 1000}s ` +
    `(last probe error: ${lastErr ? lastErr.message : 'none'}). ` +
    `Try BAHULAM_RUNTIME_DEBUG=1 for runtime stderr.`,
  );
}

function _describeDaemon(d) {
  const baseUrl = d.socketPath ? 'http://localhost' : `http://127.0.0.1:${d.port}`;
  return {
    baseUrl,
    socketPath: d.socketPath,
    port: d.port,
    frameworkVersion: d.frameworkVersion || null,
    runtimeVersion: d.runtimeVersion || null,
  };
}

/**
 * Fetch against the running runtime. Same signature as global fetch —
 * pass paths (e.g. '/api/execute') and the adapter routes to the socket
 * or TCP port automatically.
 */
export async function runtimeFetch(path, init = {}) {
  const d = await ensureRuntimeReady();
  if (d.socketPath) {
    // Node's built-in fetch (undici) supports Unix sockets via dispatcher.
    // Lazy-import undici so this file works even when the runtime is not
    // installed (e.g., in test environments).
    const { Agent } = await import('undici');
    return fetch(`http://localhost${path}`, {
      ...init,
      // @ts-expect-error — undici extension not in the TS DOM lib.
      dispatcher: new Agent({
        connect: { socketPath: d.socketPath },
      }),
    });
  }
  return fetch(`${d.baseUrl}${path}`, init);
}

/** Cleanly stop the runtime subprocess. Called on process exit. */
export function shutdownRuntime() {
  if (!_daemon) return;
  const { proc, socketPath } = _daemon;
  _daemon = null;
  try { proc.kill('SIGTERM'); } catch {}
  if (socketPath) {
    try { fs.unlinkSync(socketPath); } catch {}
  }
}

/** True when the bundled runtime binary is present. */
export function isRuntimeInstalled() {
  return fs.existsSync(_runtimeBin());
}

/** Diagnostic snapshot for `bahulam doctor`. */
export function runtimeInfo() {
  return {
    installed: isRuntimeInstalled(),
    root: _runtimeRoot(),
    bin: _runtimeBin(),
    running: !!(_daemon && _daemon.ready),
    frameworkVersion: _daemon && _daemon.frameworkVersion,
    runtimeVersion: _daemon && _daemon.runtimeVersion,
    transport: _daemon && (_daemon.socketPath ? 'unix' : 'tcp'),
  };
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Clean shutdown on Node process exit.
process.on('exit', shutdownRuntime);
process.on('SIGINT', () => { shutdownRuntime(); process.exit(130); });
process.on('SIGTERM', () => { shutdownRuntime(); process.exit(143); });
