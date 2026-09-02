/**
 * Plugin management commands — install, list, remove, enable, disable,
 * info, update.
 *
 * Design notes:
 * - Sources: git URLs, tarball URLs, local paths. No opinion on a registry
 *   yet; if a bare name is given to `install`, we look it up in the
 *   awesome-bahulam-plugins index (a plain JSON manifest hosted in the
 *   community repo).
 * - Install target: `~/.bahulam/plugins/` by default, `.bahulam/plugins/`
 *   with --project. Never global npm, never modifies the user's PATH.
 * - Disable: rename directory to `<name>.disabled`. The plugin registry
 *   only scans directories with a valid manifest, so this hides the plugin
 *   without deleting it. `enable` reverses the rename.
 * - Update: for git-installed plugins we recorded the origin in
 *   `.bahulam-plugin.json` at install time; `update` does `git fetch` +
 *   `git checkout <ref>` (or fast-forwards main).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { parsePluginManifestFile } from '../plugins/manifest.mjs';
import { preflightPlugin, existingInstalledNames } from '../plugins/preflight.mjs';
import { parsePiSource } from '../plugins/pi-compose.mjs';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

const INSTALL_STAMP = '.bahulam-plugin.json';

function searchDirs(cwd) {
  return [
    { scope: 'project', dir: path.join(cwd, '.bahulam', 'plugins') },
    { scope: 'global', dir: path.join(os.homedir(), '.bahulam', 'plugins') },
  ];
}

export function pluginTargetDir({ global, cwd }) {
  return global
    ? path.join(os.homedir(), '.bahulam', 'plugins')
    : path.join(cwd, '.bahulam', 'plugins');
}

function readManifest(dir) {
  for (const name of ['plugin.yaml', 'plugin.json']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return { manifestPath: p, manifest: parsePluginManifestFile(p) };
  }
  return null;
}

function scanInstalled(cwd) {
  const found = [];
  for (const { scope, dir } of searchDirs(cwd)) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Skip dotfile dirs (.bahulam, .git, etc.) that occasionally sit
      // alongside plugin dirs — they aren't plugins and clutter the list.
      if (entry.name.startsWith('.')) continue;
      const pluginDir = path.join(dir, entry.name);
      const disabled = entry.name.endsWith('.disabled');
      const parsed = disabled ? null : readManifest(pluginDir);
      // Require a plugin.yaml/plugin.json to count as a plugin. Anything
      // else in the plugins/ dir is stray (readManifest returns null).
      if (!parsed && !disabled) continue;
      const stamp = readStamp(pluginDir);
      const agentSlugs = (parsed?.manifest?.spec?.agents || [])
        .map(a => a.slug || a.name).filter(Boolean);
      found.push({
        scope,
        directory: pluginDir,
        directoryName: entry.name.replace(/\.disabled$/, ''),
        name: parsed?.manifest?.metadata?.name || entry.name.replace(/\.disabled$/, ''),
        version: parsed?.manifest?.metadata?.version || null,
        description: parsed?.manifest?.metadata?.description || '',
        tools: parsed?.manifest?.spec?.tools?.length || 0,
        agents: parsed?.manifest?.spec?.agents?.length || 0,
        views: parsed?.manifest?.spec?.workspace?.views?.length || 0,
        composes: parsed?.manifest?.spec?.composes?.length || 0,
        agentSlugs,
        disabled,
        origin: stamp?.origin || null,
        installed_at: stamp?.installed_at || null,
      });
    }
  }
  return found;
}

// Read the effective agent allowlist from settings for the current cwd
// (project settings override user-global). Empty array = nothing
// allowlisted; plugin agents stay workspace-scoped per PRD-102 §6.2.1.
async function readAgentAllowlist(cwd) {
  try {
    const { loadBahulamSettings } = await import('../config/settings-loader.mjs');
    const { settings } = loadBahulamSettings({ cwd });
    const list = settings?.plugins?.agent_allowlist;
    return Array.isArray(list) ? list.map(String) : [];
  } catch { return []; }
}

// pi ingredients scan: ~/.bahulam/plugins-pi/<name>/. Each entry is an
// npm package (has package.json) and may have a probe cache.
function scanPiIngredients() {
  const found = [];
  try {
    const { bahulamHome } = require('../core/paths.mjs');
    // require in ESM won't work synchronously — inline the path calc
  } catch { /* fall through */ }
  const home = process.env.BAHULAM_HOME || path.join(os.homedir(), '.bahulam');
  const piDir = path.join(home, 'plugins-pi');
  if (!fs.existsSync(piDir)) return found;
  for (const entry of fs.readdirSync(piDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(piDir, entry.name);
    let version = null, description = '', toolCount = 0;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      version = pkg.version || null;
      description = pkg.description || '';
    } catch { /* not a valid pi package */ continue; }
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(dir, '.bahulam-tools.json'), 'utf-8'));
      toolCount = Array.isArray(cache.tools) ? cache.tools.length : 0;
    } catch { /* no probe cache yet */ }
    found.push({
      name: entry.name,
      version,
      description,
      directory: dir,
      toolCount,
    });
  }
  return found;
}

function findByName(name, cwd) {
  const needle = String(name || '').trim().toLowerCase();
  return scanInstalled(cwd).find(p =>
    p.name.toLowerCase() === needle || p.directoryName.toLowerCase() === needle
  );
}

function readStamp(pluginDir) {
  try {
    const raw = fs.readFileSync(path.join(pluginDir, INSTALL_STAMP), 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

function writeStamp(pluginDir, data) {
  const stamp = { installed_at: new Date().toISOString(), ...data };
  fs.writeFileSync(path.join(pluginDir, INSTALL_STAMP), JSON.stringify(stamp, null, 2) + '\n');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

function rmrf(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// ── install ─────────────────────────────────────────────────────────

export function classifySource(source) {
  if (!source) return { kind: 'invalid' };
  const pi = parsePiSource(source);
  if (pi) return pi;
  if (String(source).trim().startsWith('pi:')) return { kind: 'invalid', reason: 'invalid pi source' };
  if (/^(git@|https?:\/\/).*(\.git|github\.com|gitlab\.com|bitbucket\.org)/i.test(source)) return { kind: 'git', url: source };
  if (/^https?:\/\/.+\.(tar\.gz|tgz|zip)(\?.*)?$/i.test(source)) return { kind: 'tarball', url: source };
  const abs = path.isAbsolute(source) ? source : path.resolve(process.cwd(), source);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return { kind: 'local', path: abs };
  return { kind: 'name', name: source };
}

export async function installFromGit({ url, targetDir, name, ref, subdir, force }) {
  const dirName = name || url.replace(/\.git$/, '').split('/').filter(Boolean).pop();
  const dest = path.join(targetDir, dirName);
  if (fs.existsSync(dest)) {
    if (!force) throw new Error(`already installed: ${dest} (use --force to overwrite)`);
    rmrf(dest);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  // Monorepo case: clone to tmp, copy the requested subdir, remove clone.
  // Single-plugin repo: clone straight into place.
  if (subdir) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-plugin-'));
    await run('git', ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, tmp]);
    const src = path.join(tmp, subdir);
    if (!fs.existsSync(src)) { rmrf(tmp); throw new Error(`subdir "${subdir}" not found in ${url}`); }
    fs.cpSync(src, dest, { recursive: true });
    rmrf(tmp);
  } else {
    await run('git', ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, dest]);
  }
  writeStamp(dest, { origin: { kind: 'git', url, ref: ref || null, subdir: subdir || null } });
  return dest;
}

export async function installFromTarball({ url, targetDir, name, force }) {
  const guessed = name || path.basename(url).replace(/\.(tar\.gz|tgz|zip)(\?.*)?$/i, '');
  const dest = path.join(targetDir, guessed);
  if (fs.existsSync(dest)) {
    if (!force) throw new Error(`already installed: ${dest} (use --force to overwrite)`);
    rmrf(dest);
  }
  fs.mkdirSync(dest, { recursive: true });
  const isZip = /\.zip(\?.*)?$/i.test(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const tmp = path.join(os.tmpdir(), `bahulam-plugin-${Date.now()}${isZip ? '.zip' : '.tgz'}`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  if (isZip) await run('unzip', ['-q', tmp, '-d', dest]);
  else await run('tar', ['-xzf', tmp, '-C', dest, '--strip-components=1']);
  fs.unlinkSync(tmp);
  writeStamp(dest, { origin: { kind: 'tarball', url } });
  return dest;
}

export async function installFromPi({ packageName, versionRange, force }) {
  // Pi packages live in ~/.bahulam/plugins-pi/ (or $BAHULAM_HOME/plugins-pi/)
  // so `bahulam plugin list` doesn't confuse them with our own packs. The
  // tool executor reads from the same canonical path via bahulamHome().
  const { bahulamHome } = await import('../core/paths.mjs');
  const piDir = path.join(bahulamHome(), 'plugins-pi');
  const safeName = packageName.replace(/[/@]/g, '_');
  const dest = path.join(piDir, safeName);
  if (fs.existsSync(dest)) {
    if (!force) throw new Error(`already installed: ${dest} (use --force to overwrite)`);
    rmrf(dest);
  }
  fs.mkdirSync(dest, { recursive: true });

  // Use `npm pack` to fetch the tarball without polluting a global npm
  // install. Extract into `<piDir>/<safeName>/package/` following npm's
  // tarball layout, then flatten one level so the plugin root has
  // package.json at top.
  const spec = versionRange ? `${packageName}@${versionRange}` : packageName;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-pi-'));
  try {
    await run('npm', ['pack', spec, '--pack-destination', tmp, '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tarballs = fs.readdirSync(tmp).filter(f => f.endsWith('.tgz'));
    if (!tarballs.length) throw new Error(`npm pack produced no tarball for ${spec}`);
    await run('tar', ['-xzf', path.join(tmp, tarballs[0]), '-C', dest, '--strip-components=1']);

    // Pi packages typically declare their runtime deps under
    // `peerDependencies` (assuming pi will provide them). We're the host
    // now, so materialize those. Two steps because npm arborist crashes
    // when peerDependencies use `*` versions during install:
    //   1. Rewrite package.json to move peers into dependencies (resolved
    //      version), and drop the peers block so the resolver stops
    //      reconciling.
    //   2. `npm install` — the dependencies section is normal for npm.
    const pkgPath = path.join(dest, 'package.json');
    let pkgJson = {};
    try { pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { /* ignore */ }
    const merged = { ...(pkgJson.dependencies || {}) };
    for (const [name, range] of Object.entries(pkgJson.peerDependencies || {})) {
      if (!merged[name]) merged[name] = range === '*' ? 'latest' : range;
    }
    if (Object.keys(merged).length) {
      const rewritten = { ...pkgJson, dependencies: merged };
      delete rewritten.peerDependencies;
      fs.writeFileSync(pkgPath, JSON.stringify(rewritten, null, 2));
      process.stderr.write(`  ${DIM}installing ${Object.keys(merged).length} pi runtime deps…${RESET}\n`);
      await run('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps', '--silent'], {
        cwd: dest,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    // Read the resolved version so the stamp captures what we actually got.
    let resolvedVersion = null;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf-8'));
      resolvedVersion = pkg.version || null;
    } catch { /* leave null */ }

    writeStamp(dest, {
      origin: {
        kind: 'pi',
        spec: `pi:${spec}`,
        package_name: packageName,
        version_range: versionRange || null,
        resolved_version: resolvedVersion,
      },
    });

    // Probe the extension once so `<dest>/.bahulam-tools.json` exists
    // right after install — lets the user inspect discovered tools with
    // `cat` and lets executor invocations skip the first-run probe cost.
    // Best-effort: failure here is non-fatal (returns tools:[] until next
    // invocation retries) so a broken extension can still be diagnosed.
    try {
      const { discoverPiTools } = await import('../plugins/pi-compat/probe.mjs');
      const shape = await discoverPiTools(dest, { pluginName: packageName, force: true });
      process.stderr.write(`  ${DIM}discovered${RESET}  ${(shape.tools || []).length} tool(s), ${(shape.commands || []).length} command(s)\n`);
    } catch (probeErr) {
      process.stderr.write(`  ${YELLOW}!${RESET} Tool discovery failed: ${probeErr.message}\n`);
      process.stderr.write(`  ${DIM}The package installed but no tools were probed. Re-probe with:${RESET}\n`);
      process.stderr.write(`  ${DIM}  node -e "import('${path.resolve('src/plugins/pi-compat/probe.mjs')}').then(m => m.discoverPiTools('${dest}', { pluginName: '${packageName}', force: true }))"${RESET}\n`);
    }
  } catch (err) {
    rmrf(dest);
    throw new Error(`pi install failed for ${spec}: ${err.message}`);
  } finally {
    rmrf(tmp);
  }
  return dest;
}

export async function installFromLocal({ src, targetDir, force }) {
  const manifestScan = readManifest(src);
  const name = manifestScan?.manifest?.metadata?.name || path.basename(src);
  const dest = path.join(targetDir, name);
  if (fs.existsSync(dest)) {
    if (!force) throw new Error(`already installed: ${dest} (use --force to overwrite)`);
    rmrf(dest);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  writeStamp(dest, { origin: { kind: 'local', path: src } });
  return dest;
}

/**
 * Auto-install pi packages referenced by a pack's spec.composes:. Callers
 * invoke this after preflight so a hand-authored pack that composes
 * missing pi ingredients still resolves in one command.
 */
export async function resolveComposeDependencies(manifest, { targetDir } = {}) {
  const composes = manifest?.spec?.composes || [];
  if (!composes.length) return;
  const { discoverPiTools } = await import('../plugins/pi-compat/probe.mjs');
  const { bahulamHome } = await import('../core/paths.mjs');
  const piBaseDir = path.join(bahulamHome(), 'plugins-pi');
  for (const compose of composes) {
    if (!compose.package_name) continue;
    const safeName = compose.package_name.replace(/[/@]/g, '_');
    const piDest = path.join(piBaseDir, safeName);
    if (!fs.existsSync(piDest)) {
      process.stderr.write(`  ${DIM}composing${RESET}  ${compose.source} → installing\n`);
      try {
        await installFromPi({
          packageName: compose.package_name,
          versionRange: compose.version_range,
          targetDir,
          force: false,
        });
      } catch (err) {
        process.stderr.write(`  ${YELLOW}!${RESET} Failed to install ${compose.source}: ${err.message}\n`);
        continue;
      }
    }
    try {
      await discoverPiTools(piDest, { pluginName: compose.package_name });
    } catch (err) {
      process.stderr.write(`  ${YELLOW}!${RESET} Probe failed for ${compose.source}: ${err.message}\n`);
    }
  }
}

// ── list ────────────────────────────────────────────────────────────

async function cmdList(args, cwd) {
  const plugins = scanInstalled(cwd);
  const pi = scanPiIngredients();
  const allowlist = new Set(await readAgentAllowlist(cwd));
  // A pack is "enabled" for this session when at least one of its
  // agents is in plugins.agent_allowlist (PRD-102 §6.2.1). Packs with
  // no agents (tools-only packs) always count as enabled — the
  // allowlist gate only exists for agents.
  const enabled = (p) => p.agentSlugs.length === 0 || p.agentSlugs.some(s => allowlist.has(s));
  const composerFor = (piName) => plugins.filter(p =>
    (p.composes > 0) && Boolean(p) // composes is a count; details need re-read
  );
  // For pi ingredient "used by" hints we re-read manifests once — cheap.
  const pluginComposes = new Map(); // pluginName → [piPackageName, …]
  for (const p of plugins) {
    if (!p.composes) continue;
    try {
      const m = readManifest(p.directory);
      const composes = m?.manifest?.spec?.composes || [];
      pluginComposes.set(p.name, composes.map(c => c.package_name || c.packageName).filter(Boolean));
    } catch { /* skip */ }
  }
  const usedBy = (piName) => [...pluginComposes.entries()]
    .filter(([, refs]) => refs.includes(piName))
    .map(([name]) => name);

  if (args.json) {
    const withEnable = plugins.map(p => ({
      ...p,
      enabled: enabled(p),
      allowlisted_agents: p.agentSlugs.filter(s => allowlist.has(s)),
    }));
    process.stdout.write(JSON.stringify({
      ok: true,
      plugins: withEnable,
      pi_ingredients: pi.map(x => ({ ...x, used_by: usedBy(x.name) })),
      agent_allowlist: [...allowlist],
    }, null, 2) + '\n');
    return;
  }

  // ── Bahulam packs ──
  if (!plugins.length && !pi.length) {
    process.stderr.write(`${DIM}No plugins installed.${RESET}\n`);
    process.stderr.write(`Install one:  ${CYAN}bahulam install <git-url|local-path|pi:name>${RESET}\n`);
    return;
  }

  if (plugins.length) {
    process.stderr.write(`\n${BOLD}BAHULAM PACKS${RESET}  ${DIM}(installed via bahulam install)${RESET}\n`);
    const nameW = Math.max(8, ...plugins.map(p => p.name.length));
    const verW = Math.max(7, ...plugins.map(p => (p.version || '—').length));
    const header = `${BOLD}${'NAME'.padEnd(nameW)}  ${'VERSION'.padEnd(verW)}  STATUS    ENABLED?  SURFACE${RESET}\n`;
    process.stderr.write(header);
    for (const p of plugins) {
      const status = p.disabled ? `${YELLOW}disabled${RESET}` : `${GREEN}active${RESET}  `;
      const enableCol = p.disabled ? DIM + '—       ' + RESET
        : enabled(p) ? GREEN + 'enabled ' + RESET
        : YELLOW + 'not-enab' + RESET;
      const surface = `${p.tools}t ${p.agents}a ${p.views}v${p.composes ? ` +${p.composes}c` : ''}`;
      process.stderr.write(
        `${p.name.padEnd(nameW)}  ${(p.version || '—').padEnd(verW)}  ${status}  ${enableCol}  ${DIM}${surface}${RESET}\n`
      );
    }
    process.stderr.write(`\n${DIM}surface: t=native-tools a=agents v=views c=composed-pi-packages${RESET}\n`);
    const notEnabled = plugins.filter(p => !p.disabled && !enabled(p));
    if (notEnabled.length) {
      process.stderr.write(`\n${YELLOW}!${RESET} ${notEnabled.length} pack${notEnabled.length === 1 ? '' : 's'} installed but NOT enabled in this session.\n`);
      process.stderr.write(`  Their plugin agents won't appear in the model's toolset until allowlisted.\n`);
      process.stderr.write(`  Add to ${CYAN}.bahulam/settings.json${RESET}:\n`);
      const slugs = notEnabled.flatMap(p => p.agentSlugs);
      process.stderr.write(`  ${DIM}{ "plugins": { "agent_allowlist": ${JSON.stringify(slugs)} } }${RESET}\n`);
    }
  }

  // ── Pi ingredients ──
  if (pi.length) {
    process.stderr.write(`\n${BOLD}PI INGREDIENTS${RESET}  ${DIM}(installed via bahulam pull pi:<name> — composable, not directly runnable)${RESET}\n`);
    const nameW = Math.max(8, ...pi.map(p => p.name.length));
    const verW = Math.max(7, ...pi.map(p => (p.version || '—').length));
    process.stderr.write(`${BOLD}${'NAME'.padEnd(nameW)}  ${'VERSION'.padEnd(verW)}  TOOLS   COMPOSED-BY${RESET}\n`);
    for (const p of pi) {
      const users = usedBy(p.name);
      const composers = users.length ? users.join(', ') : `${DIM}(nothing yet — add to a pack's composes:)${RESET}`;
      process.stderr.write(
        `${p.name.padEnd(nameW)}  ${(p.version || '—').padEnd(verW)}  ${String(p.toolCount).padStart(3)}     ${composers}\n`
      );
    }
    const orphans = pi.filter(p => usedBy(p.name).length === 0);
    if (orphans.length) {
      process.stderr.write(`\n${YELLOW}!${RESET} ${orphans.length} pi ingredient${orphans.length === 1 ? '' : 's'} installed but not composed by any pack.\n`);
      process.stderr.write(`  Pi ingredients are unusable on their own — reference in a pack's ${CYAN}spec.composes:${RESET} block.\n`);
    }
  }

  process.stderr.write('\n');
}

// ── remove ──────────────────────────────────────────────────────────

function cmdRemove(args, cwd) {
  if (!args.pluginName) throw new Error('remove requires a plugin name');
  const found = findByName(args.pluginName, cwd);
  if (!found) throw new Error(`plugin not found: ${args.pluginName}`);
  rmrf(found.directory);
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, removed: found.name, directory: found.directory }) + '\n');
    return;
  }
  process.stderr.write(`${GREEN}✓${RESET} Removed ${BOLD}${found.name}${RESET} (${found.directory})\n`);
}

// ── enable / disable ────────────────────────────────────────────────

function toggle(args, cwd, enable) {
  if (!args.pluginName) throw new Error(`${enable ? 'enable' : 'disable'} requires a plugin name`);
  const found = findByName(args.pluginName, cwd);
  if (!found) throw new Error(`plugin not found: ${args.pluginName}`);
  if (enable && !found.disabled) {
    process.stderr.write(`${DIM}${found.name} is already active.${RESET}\n`);
    return;
  }
  if (!enable && found.disabled) {
    process.stderr.write(`${DIM}${found.name} is already disabled.${RESET}\n`);
    return;
  }
  const currentBase = path.basename(found.directory);
  const newBase = enable ? currentBase.replace(/\.disabled$/, '') : `${currentBase}.disabled`;
  const target = path.join(path.dirname(found.directory), newBase);
  if (fs.existsSync(target)) throw new Error(`cannot rename: ${target} already exists`);
  fs.renameSync(found.directory, target);
  process.stderr.write(
    `${GREEN}✓${RESET} ${enable ? 'Enabled' : 'Disabled'} ${BOLD}${found.name}${RESET}\n` +
    `  ${DIM}${found.directory}${RESET}\n  ${DIM}→ ${target}${RESET}\n`
  );
}

// ── info ────────────────────────────────────────────────────────────

function cmdInfo(args, cwd) {
  if (!args.pluginName) throw new Error('info requires a plugin name');
  const found = findByName(args.pluginName, cwd);
  if (!found) throw new Error(`plugin not found: ${args.pluginName}`);
  const scan = found.disabled ? null : readManifest(found.directory);
  const m = scan?.manifest;
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, plugin: found, manifest: m || null }, null, 2) + '\n');
    return;
  }
  process.stderr.write(`\n${BOLD}${CYAN}${found.name}${RESET}${found.version ? ` v${found.version}` : ''}\n`);
  process.stderr.write(`${DIM}${found.description || '(no description)'}${RESET}\n\n`);
  process.stderr.write(`  ${DIM}scope${RESET}      ${found.scope}\n`);
  process.stderr.write(`  ${DIM}status${RESET}     ${found.disabled ? `${YELLOW}disabled${RESET}` : `${GREEN}active${RESET}`}\n`);
  process.stderr.write(`  ${DIM}directory${RESET}  ${found.directory}\n`);
  if (found.origin) {
    const o = found.origin;
    process.stderr.write(`  ${DIM}origin${RESET}     ${o.kind}${o.url ? `  ${o.url}` : ''}${o.ref ? ` @ ${o.ref}` : ''}${o.path ? `  ${o.path}` : ''}\n`);
  }
  if (found.installed_at) process.stderr.write(`  ${DIM}installed${RESET}  ${found.installed_at}\n`);
  if (m) {
    process.stderr.write(`\n  ${DIM}tools${RESET}      ${(m.spec.tools || []).map(t => t.name).join(', ') || '(none)'}\n`);
    process.stderr.write(`  ${DIM}agents${RESET}     ${(m.spec.agents || []).map(a => a.slug).join(', ') || '(none)'}\n`);
    const views = m.spec.workspace?.views || [];
    process.stderr.write(`  ${DIM}views${RESET}      ${views.length ? views.map(v => v.name).join(', ') : '(none)'}\n`);
  }
  process.stderr.write('\n');
}

// ── update ──────────────────────────────────────────────────────────

async function cmdUpdate(args, cwd) {
  if (!args.pluginName) throw new Error('update requires a plugin name');
  const found = findByName(args.pluginName, cwd);
  if (!found) throw new Error(`plugin not found: ${args.pluginName}`);
  if (!found.origin || found.origin.kind !== 'git') {
    throw new Error(`update supports git-installed plugins only (this one: ${found.origin?.kind || 'unknown'})`);
  }
  const ref = args.ref || found.origin.ref;
  const subdir = found.origin.subdir;
  process.stderr.write(`${DIM}Updating ${found.name} from ${found.origin.url}${ref ? ` @ ${ref}` : ''}${subdir ? ` (subdir ${subdir})` : ''}...${RESET}\n`);
  if (subdir) {
    // Monorepo: no .git in place, so re-fetch subdir contents into tmp
    // and rsync them over the install dir (preserves .bahulam-plugin.json).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-plugin-'));
    await run('git', ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), found.origin.url, tmp]);
    const src = path.join(tmp, subdir);
    if (!fs.existsSync(src)) { rmrf(tmp); throw new Error(`subdir "${subdir}" not found in ${found.origin.url}`); }
    // Wipe non-stamp files, then copy new contents on top.
    for (const entry of fs.readdirSync(found.directory)) {
      if (entry === INSTALL_STAMP) continue;
      rmrf(path.join(found.directory, entry));
    }
    fs.cpSync(src, found.directory, { recursive: true });
    rmrf(tmp);
  } else {
    await run('git', ['-C', found.directory, 'fetch', '--depth', '1', 'origin', ref || 'HEAD']);
    await run('git', ['-C', found.directory, 'reset', '--hard', 'FETCH_HEAD']);
  }
  writeStamp(found.directory, { origin: { ...found.origin, ref: ref || found.origin.ref } });
  const scan = readManifest(found.directory);
  process.stderr.write(`${GREEN}✓${RESET} Updated ${BOLD}${found.name}${RESET}${scan?.manifest?.metadata?.version ? ` to v${scan.manifest.metadata.version}` : ''}\n`);
}

// ── dispatcher ──────────────────────────────────────────────────────

async function cmdValidate(args, cwd) {
  // Accept a directory path OR an installed plugin name.
  const target = args.pluginName || args.source;
  if (!target) throw new Error('validate requires a plugin directory path or installed plugin name');
  let dir;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    dir = path.resolve(target);
  } else {
    const found = findByName(target, cwd);
    if (!found) throw new Error(`not found as directory or installed plugin: ${target}`);
    dir = found.directory;
  }
  // Pre-parse just to get the manifest name for the collision filter, so
  // validating an already-installed plugin doesn't flag itself as a dupe.
  const prelim = readManifest(dir);
  const selfName = (prelim?.manifest?.metadata?.name || '').toLowerCase();
  const result = await preflightPlugin(dir, {
    existingPluginNames: () => existingInstalledNames(cwd).filter(n => n.toLowerCase() !== selfName),
  });
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: result.ok, errors: result.errors, warnings: result.warnings, directory: dir }, null, 2) + '\n');
    return;
  }
  const name = result.manifest?.metadata?.name || path.basename(dir);
  process.stderr.write(`\n${BOLD}${CYAN}${name}${RESET}  ${DIM}${dir}${RESET}\n\n`);
  if (result.errors.length) {
    for (const e of result.errors) process.stderr.write(`  ${RED}✗${RESET} ${e}\n`);
  }
  if (result.warnings.length) {
    for (const w of result.warnings) process.stderr.write(`  ${YELLOW}!${RESET} ${w}\n`);
  }
  if (result.ok && !result.warnings.length) {
    process.stderr.write(`  ${GREEN}✓${RESET} no issues found\n`);
  } else if (result.ok) {
    process.stderr.write(`\n  ${GREEN}✓${RESET} ${result.warnings.length} warning(s), 0 errors — safe to install\n`);
  } else {
    process.stderr.write(`\n  ${RED}✗${RESET} ${result.errors.length} error(s) — install would be rejected\n`);
  }
  process.stderr.write('\n');
  if (!result.ok) process.exit(1);
}

export async function handlePluginManagementCommand(args, { cwd = process.cwd(), throwOnError = false } = {}) {
  try {
    switch (args.action) {
      case 'validate': case 'check': case 'lint': await cmdValidate(args, cwd); return;
      case 'list': case 'ls': await cmdList(args, cwd); return;
      case 'remove': case 'rm': case 'uninstall': cmdRemove(args, cwd); return;
      case 'enable': toggle(args, cwd, true); return;
      case 'disable': toggle(args, cwd, false); return;
      case 'info': cmdInfo(args, cwd); return;
      case 'update': case 'upgrade': await cmdUpdate(args, cwd); return;
      default: throw new Error(`unknown plugin action: ${args.action}`);
    }
  } catch (err) {
    process.stderr.write(`${RED}✗${RESET} ${err.message}\n`);
    if (throwOnError) throw err;
    process.exit(1);
  }
}
