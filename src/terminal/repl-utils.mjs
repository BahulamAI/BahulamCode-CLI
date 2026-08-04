/**
 * Small utilities shared across the split repl-* modules.
 *
 * Kept intentionally minimal — anything with real complexity or state
 * belongs in its own module.
 */

import { c } from './ansi.mjs';

// Cached cwd for recovery when the working directory is deleted mid-session.
let _cachedCwd = null;

/**
 * Return process.cwd(), recovering if the current directory was removed
 * out from under us (a nasty Node.js failure mode when the user rm -rf's
 * a directory the shell is sitting in). On recovery, chdir to the cached
 * previous cwd, then HOME, then /tmp — whichever works first.
 */
export function safeCwd() {
  try {
    _cachedCwd = process.cwd();
    return _cachedCwd;
  } catch {
    const fallback = _cachedCwd || process.env.HOME || '/tmp';
    try {
      process.chdir(fallback);
      process.stderr.write(`  ${c.yellow('Working directory was deleted. Recovered to: ' + fallback)}\n`);
      _cachedCwd = fallback;
      return fallback;
    } catch {
      return process.env.HOME || '/tmp';
    }
  }
}
