/**
 * Probe-load a pi package in an isolated child process to discover what
 * tools/commands it registers. Result is cached to <plugin-dir>/.bahulam-tools.json
 * so subsequent invocations skip the probe.
 *
 * Isolation matters: pi extensions can throw at load, do side effects,
 * or use require-in-ESM. We don't want any of that leaking into the CLI
 * process. The child does the load, prints the capture JSON, exits.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PI_TOOLS_CACHE } from '../pi-compose.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER_HOOK = path.join(HERE, 'loader-hook.mjs');
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Resolve the pi package's entry point. Prefer `package.json.main`, fall
 * back to conventional locations. A pi package may set `pi.main` — we
 * respect that first.
 */
function resolvePiEntry(pluginDir) {
  const pkgPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`Pi package missing package.json: ${pluginDir}`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  // Pi's real convention (per pi-web-access and others): `pkg.pi.extensions`
  // is an array of files OR directories. A directory means "scan for
  // *.ts/.js/.mjs entries." A file is loaded directly.
  const piExts = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
  const expandedExts = [];
  for (const rel of piExts) {
    const abs = path.resolve(pluginDir, rel);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.isFile()) { expandedExts.push(abs); continue; }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs)) {
        if (/\.(ts|mjs|js|cjs)$/.test(entry)) expandedExts.push(path.join(abs, entry));
      }
    }
  }
  if (expandedExts.length) return expandedExts;

  // Fallback: main / exports / conventional entries
  const candidates = [
    pkg.pi?.main,
    pkg.exports?.['.']?.import,
    pkg.exports?.['.']?.default,
    pkg.main,
    'index.mjs', 'index.js', 'dist/index.mjs', 'dist/index.js',
  ].filter(Boolean);
  for (const rel of candidates) {
    const abs = path.resolve(pluginDir, rel);
    if (fs.existsSync(abs)) return [abs];
  }
  throw new Error(`Pi package has no discoverable entry point (tried ${candidates.join(', ')}): ${pluginDir}`);
}

/**
 * Run the pi package in a child process, capture registered tools/commands.
 * Returns { tools: [{name, schema}], commands: [{cmd}] } — handler
 * functions are intentionally NOT included (they don't serialize).
 * Handlers get re-imported per-invocation at execution time (Step 6).
 */
export async function probePiExtension(pluginDir, { pluginName } = {}) {
  const entries = resolvePiEntry(pluginDir);
  const entryUrls = entries.map(e => pathToFileURL(e).href);
  const name = pluginName || path.basename(pluginDir);

  // Pi's canonical extension pattern: `export default function (pi) { pi.registerTool(...) }`.
  // Some packages split extensions across multiple files (pkg.pi.extensions
  // as an array or a directory). We import each in order, invoke its
  // default export with our shim, aggregate the captures.
  const script = `
    globalThis.__bahulam_pi_captured = { tools: [], commands: [] };
    (async () => {
      const entries = ${JSON.stringify(entryUrls)};
      const { pi } = await import('pi');
      const warnings = [];
      for (const url of entries) {
        try {
          const mod = await import(url);
          const activate = typeof mod?.default === 'function' ? mod.default
                         : typeof mod?.activate === 'function' ? mod.activate
                         : null;
          if (activate) {
            try { await activate(pi); }
            catch (err) { warnings.push({ entry: url, message: String(err && err.message || err) }); }
          }
        } catch (err) {
          warnings.push({ entry: url, message: String(err && err.message || err) });
        }
      }
      const out = {
        tools: globalThis.__bahulam_pi_captured.tools.map(t => ({
          name: t.name,
          description: t.description || (t.schema && t.schema.description) || '',
          input_schema: t.schema && typeof t.schema === 'object'
            ? (t.schema.parameters || t.schema.input_schema || t.schema)
            : { type: 'object', properties: {} },
        })),
        commands: globalThis.__bahulam_pi_captured.commands.map(c => ({ command: c.cmd, description: c.description || '' })),
        warnings,
      };
      process.stdout.write(JSON.stringify(out));
    })().catch(err => {
      process.stderr.write(JSON.stringify({ probe_error: String(err && err.message || err) }));
      process.exit(1);
    });
  `;

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', LOADER_HOOK, '-e', script], {
      env: { ...process.env, BAHULAM_PI_PLUGIN: name },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pi probe timed out after ${PROBE_TIMEOUT_MS}ms: ${pluginDir}`));
    }, PROBE_TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim() || `exit ${code}`;
        return reject(new Error(`pi probe failed: ${detail}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`pi probe returned invalid JSON: ${err.message}`));
      }
    });
  });
}

/**
 * Discover-or-cache: reads .bahulam-tools.json if present; probes and
 * writes it if not. Callers get a stable JSON shape either way.
 */
export async function discoverPiTools(pluginDir, opts = {}) {
  const cachePath = path.join(pluginDir, PI_TOOLS_CACHE);
  if (fs.existsSync(cachePath) && !opts.force) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch { /* fall through to probe */ }
  }
  const captured = await probePiExtension(pluginDir, opts);
  const shape = {
    tools: captured.tools,
    commands: captured.commands,
    discovered_at: new Date().toISOString(),
  };
  fs.writeFileSync(cachePath, JSON.stringify(shape, null, 2));
  return shape;
}

/**
 * Load a specific pi tool handler for execution. Re-imports the pi
 * extension entry through the shim, extracts the named tool's handler.
 * Simpler than a persistent child — ~50ms overhead per call, fine for
 * seconds-scale tool invocations. Persistent child is a Sprint 2 profile
 * decision.
 */
export async function loadPiToolHandler(pluginDir, toolName, { pluginName } = {}) {
  const entries = resolvePiEntry(pluginDir);
  const entryUrls = entries.map(e => pathToFileURL(e).href);
  const name = pluginName || path.basename(pluginDir);

  // Same activation dance as probePiExtension: import the module, call
  // its default export with our shim to trigger registrations, then look
  // up the named tool. Pi's canonical tool signature is
  // `execute(id, params)` where id is a call identifier — we generate a
  // synthetic one since our loop doesn't have a native concept for it.
  const script = `
    globalThis.__bahulam_pi_captured = { tools: [], commands: [] };
    (async () => {
      try {
        const { pi } = await import('pi');
        for (const url of ${JSON.stringify(entryUrls)}) {
          const mod = await import(url);
          const activate = typeof mod?.default === 'function' ? mod.default
                         : typeof mod?.activate === 'function' ? mod.activate
                         : null;
          if (activate) { try { await activate(pi); } catch (_) { /* one bad extension shouldn't block others */ } }
        }
        const target = globalThis.__bahulam_pi_captured.tools.find(t => t.name === ${JSON.stringify(toolName)});
        if (!target || typeof target.handler !== 'function') {
          process.stdout.write(JSON.stringify({ ok: false, error: 'tool not found or no handler: ' + ${JSON.stringify(toolName)} }));
          process.exit(0);
        }
        const args = JSON.parse(process.env.BAHULAM_PI_ARGS || '{}');
        const callId = 'bahulam-' + Date.now().toString(36);
        // Pi's descriptor-form tool signature is FIVE positional args:
        //   execute(callId, params, signal, onUpdate, ctx)
        // Passing fewer causes ctx to arrive as one of the earlier slots
        // (or undefined), which trips interactive-workflow paths that
        // then error with "Missing extension context." Match the signature
        // exactly, with a no-op signal + onUpdate for the non-interactive
        // headless case:
        //   signal   — AbortSignal from a fresh controller (never fires)
        //   onUpdate — event callback; discard in headless mode
        //   ctx      — extension context:
        //     hasUI: false          → tools resolve non-interactive workflows
        //     cwd                   → project working directory
        //     isProjectTrusted:false → conservative; shell-exec-style tools refuse
        //     model/modelRegistry   → null; model-dependent tools fail gracefully
        //     ui: null              → no UI adapter
        const controller = new AbortController();
        const ctx = {
          hasUI: false,
          cwd: process.cwd(),
          isProjectTrusted: false,
          model: null,
          modelRegistry: null,
          ui: null,
        };
        const onUpdate = () => {}; // pi may emit progress events; no-op them
        // Shim tags each capture with _form. Descriptor form invokes as
        // execute(callId, params, signal, onUpdate, ctx); positional legacy
        // form invokes as handler(args).
        const result = target._form === 'positional'
          ? await target.handler(args)
          : await target.handler(callId, args, controller.signal, onUpdate, ctx);
        const payload = typeof result === 'string'
          ? { output: result }
          : (result && typeof result === 'object' ? result : { output: String(result) });
        process.stdout.write(JSON.stringify({ ok: true, result: payload }));
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
      }
    })();
  `;

  return async function invoke(args) {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', LOADER_HOOK, '-e', script], {
        env: {
          ...process.env,
          BAHULAM_PI_PLUGIN: name,
          BAHULAM_PI_ARGS: JSON.stringify(args || {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => stdout += d);
      child.stderr.on('data', d => stderr += d);
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ success: false, output: `pi tool timed out: ${toolName}` });
      }, 60_000);
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.ok) {
            const raw = parsed.result;
            // Pi tools return an object shaped like MCP responses:
            //   { content: [{type:'text', text}], details?: { error? } }
            // Detect the details.error case so we don't dress up a
            // failure as success. The agent can then react to the
            // real error string instead of treating it as content.
            const detailsErr = raw && typeof raw === 'object' && raw.details && raw.details.error;
            if (detailsErr) {
              const txt = Array.isArray(raw.content)
                ? raw.content.map(c => c?.text || '').filter(Boolean).join('\n').trim()
                : '';
              return resolve({ success: false, output: txt || String(detailsErr) });
            }
            // Prefer explicit output, then flatten MCP-style content, then
            // fall back to the raw payload for pi tools that return a
            // simple {output: '...'}.
            let output = raw?.output;
            if (!output && Array.isArray(raw?.content)) {
              output = raw.content.map(c => c?.text || '').filter(Boolean).join('\n').trim();
            }
            return resolve({ success: true, output: output ?? raw });
          }
          return resolve({ success: false, output: parsed.error || stderr || 'pi tool failed' });
        } catch {
          resolve({ success: false, output: stderr || 'pi tool returned invalid JSON' });
        }
      });
    });
  };
}
