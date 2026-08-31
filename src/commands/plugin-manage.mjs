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

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

const REGISTRY_URL = 'https://raw.githubusercontent.com/BahulamAI/awesome-bahulam-plugins/main/registry.json';
const INSTALL_STAMP = '.bahulam-plugin.json';

function searchDirs(cwd) {
  return [
    { scope: 'project', dir: path.join(cwd, '.bahulam', 'plugins') },
    { scope: 'global', dir: path.join(os.homedir(), '.bahulam', 'plugins') },
  ];
}

function pluginTargetDir({ global, cwd }) {
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
      const pluginDir = path.join(dir, entry.name);
      const disabled = entry.name.endsWith('.disabled');
      const parsed = disabled ? null : readManifest(pluginDir);
      const stamp = readStamp(pluginDir);
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
        disabled,
        origin: stamp?.origin || null,
        installed_at: stamp?.installed_at || null,
      });
    }
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

function classifySource(source) {
  if (!source) return { kind: 'invalid' };
  if (/^(git@|https?:\/\/).*(\.git|github\.com|gitlab\.com|bitbucket\.org)/i.test(source)) return { kind: 'git', url: source };
  if (/^https?:\/\/.+\.(tar\.gz|tgz|zip)(\?.*)?$/i.test(source)) return { kind: 'tarball', url: source };
  const abs = path.isAbsolute(source) ? source : path.resolve(process.cwd(), source);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return { kind: 'local', path: abs };
  return { kind: 'name', name: source };
}

async function fetchRegistryEntry(name) {
  try {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) return null;
    const registry = await res.json();
    const list = Array.isArray(registry) ? registry : (registry.plugins || []);
    return list.find(entry => (entry.name || '').toLowerCase() === name.toLowerCase()) || null;
  } catch { return null; }
}

async function installFromGit({ url, targetDir, name, ref, subdir, force }) {
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

async function installFromTarball({ url, targetDir, name, force }) {
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

async function installFromLocal({ src, targetDir, force }) {
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

async function cmdInstall(args, cwd) {
  const source = args.source;
  if (!source) throw new Error('install requires a source (git URL, tarball URL, local path, or registry name)');
  const targetDir = pluginTargetDir({ global: args.global, cwd });
  const classified = classifySource(source);

  let dest;
  if (classified.kind === 'git') {
    dest = await installFromGit({ url: classified.url, targetDir, ref: args.ref, force: args.force });
  } else if (classified.kind === 'tarball') {
    dest = await installFromTarball({ url: classified.url, targetDir, force: args.force });
  } else if (classified.kind === 'local') {
    dest = await installFromLocal({ src: classified.path, targetDir, force: args.force });
  } else if (classified.kind === 'name') {
    const entry = await fetchRegistryEntry(classified.name);
    if (!entry) throw new Error(`no registry entry for "${classified.name}". Provide a git URL or local path instead.`);
    if (entry.repository) {
      dest = await installFromGit({ url: entry.repository, targetDir, name: entry.name, ref: args.ref || entry.ref, subdir: entry.subdir || null, force: args.force });
    } else if (entry.tarball) {
      dest = await installFromTarball({ url: entry.tarball, targetDir, name: entry.name, force: args.force });
    } else {
      throw new Error(`registry entry "${classified.name}" has no repository or tarball URL`);
    }
  } else {
    throw new Error(`could not resolve source: ${source}`);
  }

  // Hard preflight: schema, tool names, handlers import, view files exist,
  // agent tool refs resolve, no shadow of built-ins, no collisions.
  // Any error rolls back the install so we never leave a broken plugin on disk.
  const preflight = await preflightPlugin(dest, {
    existingPluginNames: () => existingInstalledNames(cwd),
  });
  if (!preflight.ok) {
    rmrf(dest);
    const detail = preflight.errors.map(e => `    · ${e}`).join('\n');
    throw new Error(`preflight failed — rolled back ${dest}:\n${detail}`);
  }
  if (preflight.warnings.length) {
    for (const w of preflight.warnings) process.stderr.write(`${YELLOW}!${RESET} ${w}\n`);
  }
  const m = preflight.manifest;
  const stamp = readStamp(dest);
  if (stamp) writeStamp(dest, stamp);

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, name: m.metadata.name, version: m.metadata.version, directory: dest }, null, 2) + '\n');
    return;
  }
  process.stderr.write(`\n${GREEN}✓${RESET} Installed ${BOLD}${m.metadata.name}${RESET} v${m.metadata.version}\n`);
  process.stderr.write(`  ${DIM}location${RESET}  ${dest}\n`);
  process.stderr.write(`  ${DIM}tools${RESET}     ${(m.spec.tools || []).map(t => t.name).join(', ') || '(none)'}\n`);
  process.stderr.write(`  ${DIM}agents${RESET}    ${(m.spec.agents || []).map(a => a.slug).join(', ') || '(none)'}\n`);
  const views = m.spec.workspace?.views || [];
  process.stderr.write(`  ${DIM}views${RESET}     ${views.length ? views.map(v => v.name).join(', ') : '(none)'}\n`);
  process.stderr.write(`\n  ${DIM}Open with:${RESET} ${CYAN}bahulam plugin ${m.metadata.name}${RESET}\n\n`);
}

// ── list ────────────────────────────────────────────────────────────

function cmdList(args, cwd) {
  const plugins = scanInstalled(cwd);
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, plugins }, null, 2) + '\n');
    return;
  }
  if (!plugins.length) {
    process.stderr.write(`${DIM}No plugins installed.${RESET}\n`);
    process.stderr.write(`Install one:  ${CYAN}bahulam plugin install <git-url|local-path|name>${RESET}\n`);
    return;
  }
  const nameW = Math.max(8, ...plugins.map(p => p.name.length));
  const verW = Math.max(7, ...plugins.map(p => (p.version || '—').length));
  const scopeW = 7;
  const header = `${BOLD}${'NAME'.padEnd(nameW)}  ${'VERSION'.padEnd(verW)}  ${'SCOPE'.padEnd(scopeW)}  STATUS  SURFACE${RESET}\n`;
  process.stderr.write(header);
  for (const p of plugins) {
    const status = p.disabled ? `${YELLOW}disabled${RESET}` : `${GREEN}active${RESET}  `;
    const surface = `${p.tools}t ${p.agents}a ${p.views}v`;
    process.stderr.write(
      `${p.name.padEnd(nameW)}  ${(p.version || '—').padEnd(verW)}  ${p.scope.padEnd(scopeW)}  ${status}  ${DIM}${surface}${RESET}\n`
    );
  }
  process.stderr.write(`\n${DIM}${plugins.length} plugin${plugins.length === 1 ? '' : 's'} · surface: t=tools a=agents v=views${RESET}\n`);
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
      case 'install': await cmdInstall(args, cwd); return;
      case 'validate': case 'check': case 'lint': await cmdValidate(args, cwd); return;
      case 'list': case 'ls': cmdList(args, cwd); return;
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
