/**
 * Top-level `bahulam pull` and `bahulam install` commands.
 *
 *   bahulam pull <src>     — install an ingredient (currently pi:<name>).
 *                            No pack scaffolding; the raw package lands in
 *                            ~/.bahulam/plugins-pi/ and is only useful when
 *                            referenced by a pack's spec.composes:.
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
  a pack's ${CYAN}spec.composes:${RESET} block, or use ${CYAN}bahulam install pi:<name>${RESET}
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
    process.stderr.write(`  ${DIM}Compose in yours:${RESET} ${CYAN}spec.composes: [{source: pi:${classified.package_name}, expose: [...]}]${RESET}\n\n`);
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
  installs it. For git/tarball/local sources, installs the existing pack.

  Sources:
    pi:<npm-package>[@<version>]     Scaffold + install from a pi package
    <git-url>[.git]                  Clone a hand-authored pack
    <tarball-url>                    Download + install a pack tarball
    <local-path>                     Copy + install a local pack directory

  Flags:
    --force, -f            Overwrite an existing pack at the same target
    --slug <name>          Override the scaffolded pack slug (pi sources only)
    --no-state             Skip the persistent state layer (pi sources only)
    --no-workspace         Skip the reactive workspace panel (pi sources only)
    --project              Install into ./.bahulam/plugins/ instead of ~/.bahulam/plugins/
    --ref <ref>            Git branch/tag/commit (git sources only)
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

    // Non-pi paths reuse the plugin-manage install machinery.
    let dest;
    if (classified.kind === 'git') {
      dest = await installFromGit({ url: classified.url, targetDir, ref: args.ref, force: args.force });
    } else if (classified.kind === 'tarball') {
      dest = await installFromTarball({ url: classified.url, targetDir, force: args.force });
    } else if (classified.kind === 'local') {
      dest = await installFromLocal({ src: classified.path, targetDir, force: args.force });
    } else if (classified.kind === 'name') {
      throw new Error(`registry lookup for bare names is not yet wired into \`bahulam install\`. Provide a git URL, tarball URL, local path, or pi: source.`);
    } else {
      throw new Error(`could not resolve source: ${args.source}`);
    }

    await preflightAndReport({ dest, args, cwd });
  } catch (err) {
    process.stderr.write(`\x1b[31m✗\x1b[0m ${err.message}\n`);
    process.exit(1);
  }
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
  const nativeTools = (m.spec.tools || []).map(t => t.name);
  const composedCount = (m.spec.composes || []).reduce((n, c) => n + ((c.expose || []).length || 0), 0);
  process.stderr.write(`  ${DIM}tools${RESET}     ${nativeTools.length ? nativeTools.join(', ') : '(none)'}${composedCount ? ` ${DIM}+ ${composedCount} composed${RESET}` : ''}\n`);
  process.stderr.write(`  ${DIM}agents${RESET}    ${(m.spec.agents || []).map(a => a.slug).join(', ') || '(none)'}\n`);
  const views = m.spec.workspace?.views || [];
  process.stderr.write(`  ${DIM}views${RESET}     ${views.length ? views.map(v => v.name).join(', ') : '(none)'}\n`);
  if (meta) {
    process.stderr.write(`  ${DIM}scaffolded${RESET} from ${CYAN}pi:${meta.packageName}${RESET} (namespace ${CYAN}${meta.namespace}${RESET}, ${meta.exposeTools.length} composed tool${meta.exposeTools.length === 1 ? '' : 's'})\n`);
    process.stderr.write(`  ${DIM}Edit the pack under ${dest} to customize.${RESET}\n`);
  }
  process.stderr.write(`\n  ${DIM}Open with:${RESET} ${CYAN}bahulam plugin ${m.metadata.name}${RESET}\n\n`);
}
