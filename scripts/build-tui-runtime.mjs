import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = process.platform === 'win32' ? 'bahulam-tui.exe' : 'bahulam-tui';
const target = path.join(root, 'rust', 'target');
execFileSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked',
  '--release', '--target-dir', target, '--bin', 'bahulam-tui'], {cwd: root, stdio: 'inherit'});
const directory = path.join(root, 'native', process.platform + '-' + process.arch);
mkdirSync(directory, {recursive: true});
const runtime = path.join(directory, name);
// Replace the inode so macOS cannot reuse a cached signature for the old binary.
const staged = path.join(directory, process.pid + '-' + name);
try {
  copyFileSync(path.join(target, 'release', name), staged);
  chmodSync(staged, 0o755);
  execFileSync(staged, ['--version'], {stdio: 'inherit'});
  renameSync(staged, runtime);
} finally {
  rmSync(staged, {force: true});
}
