/**
 * Shared npm-install helper for pack and ingredient installs.
 *
 * Two responsibilities:
 *   1. Materialize node_modules/ from package.json::dependencies
 *      (co-located with the package/pack, no shared/global install).
 *   2. Gate execution of postinstall scripts on a verified-package
 *      allowlist. Unverified packages run `npm install --ignore-scripts`
 *      so a malicious postinstall can't execute on `bahulam pull`.
 *
 * Pi peer-dep quirk: pi packages often declare peerDependencies with `*`
 * ranges, which crashes npm arborist. We migrate peers → dependencies
 * before install. Native packs (hand-authored) don't need that step;
 * their package.json is already ordinary.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

// Verified list: packages we've reviewed and trust to run postinstall.
// v1 ships an inline dev-time list that mirrors what we're actively
// using. Long term this migrates to `~/.bahulam/verified-pi-packages.json`
// synced from awesome-bahulam-plugins (§13.6.1c of PRD-102).
//
// The dev-time list intentionally covers only pi packages we've actually
// pulled and confirmed. Every other package installs with --ignore-scripts
// until reviewed.
const DEV_VERIFIED_PI_PACKAGES = new Set([
  'pi-web-access',
  'pi-redmine',
  'pi-goal-x',
  '@speclip/pi-media',
]);

/**
 * Determine whether a package is verified (postinstall scripts allowed).
 * Reads ~/.bahulam/verified-pi-packages.json if present; falls back to
 * the built-in dev list.
 */
export function isPackageVerified(packageName, { bahulamHomeDir = null } = {}) {
  if (!packageName) return false;
  if (DEV_VERIFIED_PI_PACKAGES.has(packageName)) return true;
  const home = bahulamHomeDir || process.env.BAHULAM_HOME || path.join(os.homedir(), '.bahulam');
  const registryPath = path.join(home, 'verified-pi-packages.json');
  if (fs.existsSync(registryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      if (data && typeof data === 'object' && data[packageName]) return true;
    } catch { /* fall through */ }
  }
  return false;
}

function runNpm(args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stderr = '';
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(' ')} exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

/**
 * Migrate peerDependencies → dependencies (pi packages only) to sidestep
 * the npm arborist crash on `*` ranges. Idempotent.
 */
function migratePeersForPi(pkgPath) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { return {}; }
  const peers = pkg.peerDependencies || {};
  const merged = { ...(pkg.dependencies || {}) };
  let changed = false;
  for (const [name, range] of Object.entries(peers)) {
    if (!merged[name]) {
      merged[name] = range === '*' ? 'latest' : range;
      changed = true;
    }
  }
  // Some current pi packages import the Pi server runtime transitively
  // through @earendil-works/pi-coding-agent without declaring it. Materialize
  // it here so discovery can import the extension and capture tools.
  if (merged['@earendil-works/pi-coding-agent'] && !merged['@earendil-works/pi-server']) {
    merged['@earendil-works/pi-server'] = 'latest';
    changed = true;
  }
  if (!changed && !Object.keys(peers).length) return pkg;
  const rewritten = { ...pkg, dependencies: merged };
  delete rewritten.peerDependencies;
  fs.writeFileSync(pkgPath, JSON.stringify(rewritten, null, 2));
  return rewritten;
}

/**
 * Install the package's dependencies into a co-located node_modules.
 * If the package.json has no deps, no-op (returns { installed: 0 }).
 *
 * @param {Object} opts
 * @param {string} opts.dir             Package/pack root directory
 * @param {string} [opts.packageName]   For verified-list lookup + logs
 * @param {'pi'|'pack'} [opts.kind]     Which peer-migration behavior to use
 * @param {boolean} [opts.forceScripts] Force scripts on (ignores verified list)
 * @param {Function} [opts.log]         Log fn (line-oriented). Defaults to stderr.
 * @returns {Promise<{installed: number, ranScripts: boolean, verified: boolean}>}
 */
export async function installPackageDependencies({
  dir,
  packageName = null,
  kind = 'pack',
  forceScripts = false,
  log = null,
} = {}) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return { installed: 0, ranScripts: false, verified: false };

  const write = log || ((msg) => process.stderr.write(`  ${msg}\n`));

  // Pi ingredients: migrate peerDependencies → dependencies before install.
  const pkg = kind === 'pi' ? migratePeersForPi(pkgPath) : (() => {
    try { return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { return {}; }
  })();

  const depCount = Object.keys(pkg.dependencies || {}).length;
  if (depCount === 0) return { installed: 0, ranScripts: false, verified: false };

  const verified = forceScripts || isPackageVerified(packageName);
  const scriptsFlag = verified ? [] : ['--ignore-scripts'];
  const label = kind === 'pi' ? 'pi runtime deps' : 'pack npm deps';

  write(`${DIM}installing ${depCount} ${label}${verified ? '' : ' (scripts skipped — unverified)'}…${RESET}`);
  await runNpm(
    ['install', '--no-audit', '--no-fund', '--legacy-peer-deps', '--silent', ...scriptsFlag],
    { cwd: dir },
  );

  if (!verified && packageName) {
    write(`${YELLOW}!${RESET} ${DIM}${packageName} is not in the verified list — postinstall scripts were skipped. Some packages need scripts to build native modules; if the pack fails at first use, re-install with ${RESET}--force-scripts${DIM} once you've reviewed the package.${RESET}`);
  }

  return { installed: depCount, ranScripts: verified, verified };
}
