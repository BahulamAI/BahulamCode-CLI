/**
 * Top-level `bahulam pull` and `bahulam install` commands.
 *
 *   bahulam pull <src>     — install an ingredient (currently pi:<name>).
 *                            No pack scaffolding; the raw package lands in
 *                            ~/.bahulam/plugins-pi/ and is only useful when
 *                            referenced by a pack's config.composes:.
 *
 *   bahulam install <src>  — install a full pack.
 *                            For pi:<name>: pulls the ingredient AND
 *                            scaffolds a Bahulam pack around it (composes +
 *                            native state layer + agent + workspace panel),
 *                            then installs the pack via preflight.
 *                            For git URL / tarball URL / local path: installs
 *                            as a hand-authored pack (delegates to the
 *                            existing plugin-manage install path).
 *
 * The split lets users pull pi ingredients they only need as compose targets
 * without generating a full pack, while giving one-command installs for
 * users who want an agent-ready surface from a pi package.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  classifySource,
  installFromGit,
  installFromTarball,
  installFromLocal,
  installFromPi,
  pluginTargetDir,
  resolveComposeDependencies,
} from './plugin-manage.mjs';
import { preflightPlugin, existingInstalledNames } from '../plugins/preflight.mjs';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

const DEFAULT_BAHULAM_PLUGIN_REGISTRY_URL =
  'https://raw.githubusercontent.com/BahulamAI/awesome-bahulam-plugins/main/registry.json';

function parseArgs(argv) {
  const parsed = {
    source: null,
    force: false,
    global: true,
    ref: null,
    json: false,
    help: false,
    slug: null,
    state: true,
    workspace: true,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help': case '-h': parsed.help = true; break;
      case '--force': case '-f': parsed.force = true; break;
      case '--project': parsed.global = false; break;
      case '--global': parsed.global = true; break;
      case '--ref': case '--tag': case '--branch': parsed.ref = argv[++i]; break;
      case '--json': parsed.json = true; break;
      case '--slug': case '--name': parsed.slug = argv[++i]; break;
      case '--no-state': parsed.state = false; break;
      case '--no-workspace': parsed.workspace = false; break;
      default:
        if (!arg.startsWith('-')) positional.push(arg);
        break;
    }
  }
  parsed.source = positional.shift() || null;
  return parsed;
}

/**
 * `bahulam pull <src>` — ingredient only. Currently pi: sources only.
 */
export async function handlePullCommand(argv, { cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  if (args.help || !args.source) {
    process.stderr.write(`
  ${BOLD}bahulam pull <source>${RESET}

  Pull an ingredient (pi package) into ~/.bahulam/plugins-pi/. The
  ingredient is composable but not directly runnable — reference it from
  a pack's ${CYAN}config.composes:${RESET} block, or use ${CYAN}bahulam install pi:<name>${RESET}
  to auto-scaffold a full pack around it.

  Sources:
    pi:<npm-package>[@<version>]     Pull a pi package (e.g. pi:pi-web-access@^0.27.0)

  Flags:
    --force, -f            Overwrite an existing ingredient at the same path
    --json                 Machine-readable output

`);
    if (!args.source) process.exit(1);
    return;
  }

  const classified = classifySource(args.source);
  if (classified.kind !== 'pi') {
    if (classified.kind === 'invalid') {
      throw new Error(`invalid pi source: ${args.source}`);
    }
    throw new Error(
      `pull only accepts pi: sources. For ${classified.kind} sources use \`bahulam install ${args.source}\`.`,
    );
  }

  try {
    const dest = await installFromPi({
      packageName: classified.package_name,
      versionRange: classified.version_range,
      force: args.force,
    });
    if (args.json) {
      process.stdout.write(JSON.stringify({
        ok: true,
        kind: 'pi',
        package_name: classified.package_name,
        version_range: classified.version_range,
        directory: dest,
      }, null, 2) + '\n');
      return;
    }
    process.stderr.write(`\n${GREEN}✓${RESET} Pulled pi package ${BOLD}${classified.package_name}${RESET}\n`);
    process.stderr.write(`  ${DIM}location${RESET}  ${dest}\n`);
    process.stderr.write(`  ${YELLOW}!${RESET} Pi packages run with your full system permissions. Bahulam does not audit pi packages.\n`);
    process.stderr.write(`  ${DIM}Wrap in a pack:${RESET}  ${CYAN}bahulam install pi:${classified.package_name}${RESET}\n`);
    process.stderr.write(`  ${DIM}Compose in yours:${RESET} ${CYAN}config.composes: [{source: pi:${classified.package_name}, expose: [...]}]${RESET}\n\n`);
  } catch (err) {
    process.stderr.write(`\x1b[31m✗\x1b[0m ${err.message}\n`);
    process.exit(1);
  }
}

/**
 * `bahulam install <src>` — full pack install.
 *   pi:<name>  → pull ingredient + scaffold pack + preflight-install
 *   git URL    → clone + preflight-install
 *   tarball    → download + preflight-install
 *   local path → copy + preflight-install
 */
export async function handleInstallCommand(argv, { cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  if (args.help || !args.source) {
    process.stderr.write(`
  ${BOLD}bahulam install <source>${RESET}

  Install a pack. For pi sources, pulls the ingredient and scaffolds a
  full Bahulam pack (composition + state layer + workspace + agent), then
  installs it. For registry/git/tarball/local sources, installs the
  existing pack.

  Sources:
    pi:<npm-package>[@<version>]     Scaffold + install from a pi package
    <registry-name>                  Install from awesome-bahulam-plugins
    bahulam:<registry-name>          Explicit awesome-bahulam-plugins lookup
    <git-url>[.git]                  Clone a hand-authored pack
    <tarball-url>                    Download + install a pack tarball
    <local-path>                     Copy + install a local pack directory

  Flags:
    --force, -f            Overwrite an existing pack at the same target
    --slug <name>          Override the scaffolded pack slug (pi sources only)
    --no-state             Skip the persistent state layer (pi sources only)
    --no-workspace         Skip the reactive workspace panel (pi sources only)
    --project              Install into ./.bahulam/plugins/ instead of ~/.bahulam/plugins/
    --ref <ref>            Git branch/tag/commit (git or registry sources)
    --json                 Machine-readable output

`);
    if (!args.source) process.exit(1);
    return;
  }

  const classified = classifySource(args.source);
  const targetDir = pluginTargetDir({ global: args.global, cwd });

  try {
    if (classified.kind === 'pi') {
      await installPiWithScaffolding({ classified, targetDir, cwd, args });
      return;
    }
    if (classified.kind === 'invalid') {
      throw new Error(`unrecognized source: ${args.source}`);
    }

    const registryName = registryNameFromSource(args.source, classified);
    if (registryName) {
      await installFromBahulamRegistry({ name: registryName, targetDir, cwd, args });
      return;
    }

    // Non-pi paths reuse the plugin-manage install machinery.
    let dest;
    if (classified.kind === 'git') {
      dest = await installFromGit({ url: classified.url, targetDir, ref: args.ref, force: args.force });
    } else if (classified.kind === 'tarball') {
      dest = await installFromTarball({ url: classified.url, targetDir, force: args.force });
    } else if (classified.kind === 'local') {
      dest = await installFromLocal({ src: classified.path, targetDir, force: args.force });
    } else {
      throw new Error(`could not resolve source: ${args.source}`);
    }

    await preflightAndReport({ dest, args, cwd });
  } catch (err) {
    process.stderr.write(`\x1b[31m✗\x1b[0m ${err.message}\n`);
    process.exit(1);
  }
}

export function registryNameFromSource(source, classified = null) {
  const raw = String(source || '').trim();
  const prefix = 'bahulam:';
  if (raw.toLowerCase().startsWith(prefix)) {
    const name = raw.slice(prefix.length).trim();
    if (!name) {
      throw new Error(`bahulam registry source requires a plugin name, e.g. ${CYAN}bahulam:manim-studio${RESET}`);
    }
    return name;
  }
  if (classified?.kind === 'name') return classified.name;
  return null;
}

async function installFromBahulamRegistry({ name, targetDir, cwd, args }) {
  const entry = await resolveBahulamRegistryPlugin(name, { cwd });
  const repository = entry.repository || entry.repo || entry.url;
  if (!repository) {
    throw new Error(`registry entry "${entry.name}" is missing a repository URL`);
  }
  const ref = args.ref || entry.ref || null;
  const subdir = entry.subdir || entry.path || null;

  process.stderr.write(
    `${DIM}registry${RESET}  ${entry.name} → ${repository}` +
    `${subdir ? `#${subdir}` : ''}${ref ? ` @ ${ref}` : ''}\n`,
  );

  const dest = await installFromGit({
    url: repository,
    targetDir,
    name: entry.name,
    ref,
    subdir,
    force: args.force,
  });
  await preflightAndReport({ dest, args, cwd });
}

export async function resolveBahulamRegistryPlugin(name, { cwd = process.cwd(), registry = null } = {}) {
  const doc = registry || await loadBahulamPluginRegistry({ cwd });
  const entries = Array.isArray(doc) ? doc : Array.isArray(doc?.plugins) ? doc.plugins : [];
  if (!entries.length) {
    throw new Error('Bahulam plugin registry did not contain any plugins');
  }

  const needle = normalizeRegistryName(name);
  const entry = entries.find(item => {
    const names = [
      item?.name,
      item?.slug,
      item?.id,
      ...(Array.isArray(item?.aliases) ? item.aliases : []),
    ];
    return names.some(candidate => normalizeRegistryName(candidate) === needle);
  });

  if (!entry) {
    throw new Error(
      `plugin not found in Bahulam registry: ${name}\n` +
      `Available: ${entries.map(item => item.name).filter(Boolean).join(', ') || '(none)'}`,
    );
  }
  return entry;
}

async function loadBahulamPluginRegistry({ cwd = process.cwd() } = {}) {
  const explicit =
    process.env.BAHULAM_PLUGIN_REGISTRY ||
    process.env.BAHULAM_PLUGIN_REGISTRY_PATH ||
    process.env.BAHULAM_PLUGIN_REGISTRY_URL;
  if (explicit) return readRegistryLocation(explicit, cwd);

  try {
    return await readRegistryLocation(DEFAULT_BAHULAM_PLUGIN_REGISTRY_URL, cwd);
  } catch (err) {
    const localPath = findLocalRegistry(cwd);
    if (localPath) return readRegistryJson(localPath);
    throw new Error(`failed to load Bahulam plugin registry: ${err.message}`);
  }
}

async function readRegistryLocation(location, cwd) {
  if (/^https?:\/\//i.test(location)) {
    const res = await fetch(location, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${location} returned HTTP ${res.status}`);
    return res.json();
  }
  const filePath = path.isAbsolute(location) ? location : path.resolve(cwd, location);
  return readRegistryJson(filePath);
}

function readRegistryJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`failed to read registry ${filePath}: ${err.message}`);
  }
}

function findLocalRegistry(cwd) {
  const candidates = [
    path.resolve(cwd, '../awesome-bahulam-plugins/registry.json'),
    path.resolve(cwd, 'awesome-bahulam-plugins/registry.json'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function normalizeRegistryName(name) {
  return String(name || '').trim().replace(/^bahulam:/i, '').toLowerCase();
}

async function installPiWithScaffolding({ classified, targetDir, cwd, args }) {
  const { bahulamHome } = await import('../core/paths.mjs');
  const { discoverPiTools } = await import('../plugins/pi-compat/probe.mjs');
  const { scaffoldPiPack } = await import('../plugins/pi-compat/scaffold.mjs');

  const piBaseDir = path.join(bahulamHome(), 'plugins-pi');
  const safeName = classified.package_name.replace(/[/@]/g, '_');
  const piDir = path.join(piBaseDir, safeName);

  // Step 1: pull the ingredient if we haven't already.
  if (!fs.existsSync(piDir)) {
    process.stderr.write(`${DIM}pulling ${classified.package_name}…${RESET}\n`);
    await installFromPi({
      packageName: classified.package_name,
      versionRange: classified.version_range,
      force: false,
    });
  } else {
    process.stderr.write(`${DIM}reusing existing ingredient at ${piDir}${RESET}\n`);
  }

  // Step 2: ensure the tools cache is present.
  const discovered = await discoverPiTools(piDir, { pluginName: classified.package_name });

  // Step 2b: host check for required binaries. Install (unlike pull)
  // implies "use this now", so a missing ffmpeg-class dep will fail at
  // first tool call — better to fail loudly here. `--force` bypasses
  // for offline provisioning / CI where deps land later.
  await enforceHostRequirements({ piDir, packageName: classified.package_name, args });

  // Step 3: generate the pack directory (composes + state + agent + panel).
  process.stderr.write(`${DIM}scaffolding pack…${RESET}\n`);
  const { dest, slug, namespace, exposeTools, agentSlug } = scaffoldPiPack({
    packageName: classified.package_name,
    versionRange: classified.version_range,
    piDir,
    targetDir,
    discoveredTools: discovered,
    state: args.state,
    workspace: args.workspace,
    slug: args.slug,
    force: args.force,
  });

  // Step 4: preflight the generated pack. Same rules as any other pack.
  await preflightAndReport({ dest, args, cwd, meta: { slug, namespace, exposeTools, agentSlug, packageName: classified.package_name } });
}

async function preflightAndReport({ dest, args, cwd, meta = null }) {
  const preflight = await preflightPlugin(dest, {
    existingPluginNames: () => existingInstalledNames(cwd),
  });
  if (!preflight.ok) {
    fs.rmSync(dest, { recursive: true, force: true });
    const detail = preflight.errors.map(e => `    · ${e}`).join('\n');
    throw new Error(`preflight failed — rolled back ${dest}:\n${detail}`);
  }
  if (preflight.warnings.length) {
    for (const w of preflight.warnings) process.stderr.write(`${YELLOW}!${RESET} ${w}\n`);
  }
  const m = preflight.manifest;

  // A hand-authored pack may compose pi packages we haven't pulled yet.
  // Do it in one command; the scaffolder path already has the pi ingredient.
  await resolveComposeDependencies(m, { targetDir: path.dirname(dest) });

  // Host check for each composed pi ingredient (same policy as the
  // scaffolder path). Blocks install if a required binary is missing.
  const composes = m.config?.composes || [];
  if (composes.length && !meta) {
    // meta present == scaffolder path already did this pre-scaffold
    const { bahulamHome } = await import('../core/paths.mjs');
    const piBaseDir = path.join(bahulamHome(), 'plugins-pi');
    for (const compose of composes) {
      if (!compose.package_name) continue;
      const safeName = compose.package_name.replace(/[/@]/g, '_');
      const piDir = path.join(piBaseDir, safeName);
      if (!fs.existsSync(piDir)) continue;
      try {
        await enforceHostRequirements({ piDir, packageName: compose.package_name, args });
      } catch (err) {
        // Roll back the pack install — the composed dep won't work.
        fs.rmSync(dest, { recursive: true, force: true });
        throw err;
      }
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      name: m.metadata.name,
      version: m.metadata.version,
      directory: dest,
      scaffolded: Boolean(meta),
      ...(meta ? { pi_package: meta.packageName, namespace: meta.namespace, composed_tools: meta.exposeTools, agent: meta.agentSlug } : {}),
    }, null, 2) + '\n');
    return;
  }

  process.stderr.write(`\n${GREEN}✓${RESET} Installed ${BOLD}${m.metadata.name}${RESET} v${m.metadata.version}\n`);
  process.stderr.write(`  ${DIM}location${RESET}  ${dest}\n`);
  const nativeTools = (m.config.tools || []).map(t => t.name);
  const composedCount = (m.config.composes || []).reduce((n, c) => n + ((c.expose || []).length || 0), 0);
  process.stderr.write(`  ${DIM}tools${RESET}     ${nativeTools.length ? nativeTools.join(', ') : '(none)'}${composedCount ? ` ${DIM}+ ${composedCount} composed${RESET}` : ''}\n`);
  process.stderr.write(`  ${DIM}agents${RESET}    ${(m.config.agents || []).map(a => a.slug).join(', ') || '(none)'}\n`);
  const views = m.config.workspace?.views || [];
  process.stderr.write(`  ${DIM}views${RESET}     ${views.length ? views.map(v => v.name).join(', ') : '(none)'}\n`);
  if (meta) {
    process.stderr.write(`  ${DIM}scaffolded${RESET} from ${CYAN}pi:${meta.packageName}${RESET} (namespace ${CYAN}${meta.namespace}${RESET}, ${meta.exposeTools.length} composed tool${meta.exposeTools.length === 1 ? '' : 's'})\n`);
    process.stderr.write(`  ${DIM}Edit the pack under ${dest} to customize.${RESET}\n`);
  }
  process.stderr.write(`\n  ${DIM}Open with:${RESET} ${CYAN}bahulam plugin ${m.metadata.name}${RESET}\n\n`);
}

/**
 * Install-time host check: read the ingredient's requirements sidecar,
 * verify each detected binary is on PATH. Throws with an actionable
 * message (per-OS install hints) if anything required is missing.
 * `--force` bypasses (for CI, offline provisioning, dev workflows where
 * deps land later).
 *
 * Env vars / credentials are warn-only — many pi tools have optional
 * features and blocking on a missing PEXELS_API_KEY when the user only
 * wants media_probe is too aggressive.
 */
async function enforceHostRequirements({ piDir, packageName, args }) {
  const { checkRequirementsAgainstHost, REQUIREMENTS_FILE, analyzeRequirements } =
    await import('../plugins/pi-compat/requirements.mjs');

  const sidecar = path.join(piDir, REQUIREMENTS_FILE);
  let reqs = null;
  if (fs.existsSync(sidecar)) {
    try { reqs = JSON.parse(fs.readFileSync(sidecar, 'utf-8')); } catch { /* re-analyze */ }
  }
  if (!reqs) {
    // Sidecar was missing (older ingredient install or analyzer crash) —
    // synthesize on the fly so the check is never silently skipped.
    let discoveredTools = null;
    const toolsCache = path.join(piDir, '.bahulam-tools.json');
    if (fs.existsSync(toolsCache)) {
      try { discoveredTools = JSON.parse(fs.readFileSync(toolsCache, 'utf-8')); } catch { /* ignore */ }
    }
    reqs = analyzeRequirements(piDir, { discoveredTools });
  }
  if (!reqs?.system_binaries?.length) {
    // Nothing to check.
    return;
  }

  const host = checkRequirementsAgainstHost(reqs);
  const missing = host.binaries.filter(b => !b.found);
  if (missing.length === 0) return;

  const platformKey = process.platform === 'darwin' ? 'darwin' : 'linux';
  const lines = [];
  lines.push(`${packageName} needs ${missing.length} system binar${missing.length === 1 ? 'y' : 'ies'} not found on your PATH:`);
  for (const b of missing) {
    const hint = b.install_hints?.[platformKey];
    lines.push(`  · ${b.name}${hint ? ` — install: ${CYAN}${hint}${RESET}` : ''}`);
  }
  if (args.force) {
    process.stderr.write(`${YELLOW}!${RESET} ${lines.join('\n')}\n`);
    process.stderr.write(`${YELLOW}!${RESET} ${DIM}--force set — continuing anyway. Composed tools using these binaries will fail at first call.${RESET}\n`);
    return;
  }
  const err = new Error(
    `${lines.join('\n')}\n\n` +
    `Install the missing binaries, then rerun. Or use ${CYAN}--force${RESET} to install without them (composed tools using these will fail at first call).\n` +
    `Verify anytime with: ${CYAN}bahulam plugin doctor pi:${packageName}${RESET}`,
  );
  throw err;
}
