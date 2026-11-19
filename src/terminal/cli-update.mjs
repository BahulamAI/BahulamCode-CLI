import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { bahulamHome } from '../core/paths.mjs';

const registry = 'https://registry.npmjs.org';
const release = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

export async function availableUpdate(pkg, fetchRegistry = fetch) {
  const current = release.exec(pkg.version);
  if (!current) return;
  const beta = current[4] !== undefined;
  const response = await fetchRegistry(registry + '/' + encodeURIComponent(pkg.name) + '/' + (beta ? 'beta' : 'latest'), {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) return;
  const { version } = await response.json();
  const next = release.exec(version);
  if (!next || (next[4] !== undefined) !== beta) return;
  for (let i = 1; i <= (beta ? 4 : 3); i++) {
    if (+next[i] !== +current[i]) return +next[i] > +current[i] ? version : undefined;
  }
}

async function installGlobal(spec) {
  const args = ['install', '--global', spec, '--registry=' + registry];
  let executable = 'npm';
  if (process.platform === 'win32') {
    executable = process.execPath;
    args.unshift(path.join(path.dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  await promisify(execFile)(executable, args, { cwd: homedir(), timeout: 120_000, windowsHide: true });
}

export async function promptUpdate({ pkg, version, choose, notify, install = installGlobal, home = bahulamHome() }) {
  if (!release.test(version)) return;
  const dir = path.join(home, 'cache', 'skipped-cli-updates');
  const marker = path.join(dir, version);
  try { await access(marker); return; } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const choice = await choose('Bahulam Code update available', [
    { label: 'Cancel for now', value: 'cancel' },
    { label: 'Install globally', value: 'install' },
    { label: 'Skip this version', value: 'skip' },
  ], 'Installed ' + pkg.version + ' → Available ' + version);
  if (choice === 'skip') {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(marker, '', { mode: 0o600 });
    } catch {
      await notify('Could not save skipped version', 'This update may appear again on the next launch.');
    }
  } else if (choice === 'install') {
    const spec = pkg.name + '@' + version;
    await notify('Installing ' + spec, 'You can continue using this session.');
    try {
      await install(spec);
    } catch {
      await notify('Update failed', 'Run npm install -g ' + spec + ' in your shell to retry and see the npm error.');
      return;
    }
    await notify('Installed ' + spec, 'Start a new bahulam process to use the global installation.');
  }
}
