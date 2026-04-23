/**
 * Safety Guardrails — prevent destructive tool execution.
 *
 * Protects against:
 * - Deleting/overwriting source code directories
 * - rm -rf on critical paths
 * - Writing outside allowed boundaries
 * - Dangerous shell commands (fork bombs, disk wipes, etc.)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

// ── Protected Paths ──────────────────────────────────────────

/** Files/dirs that should NEVER be deleted or overwritten wholesale. */
const PROTECTED_NAMES = new Set([
  '.git',
  '.env',
  '.env.local',
  '.env.production',
  'node_modules',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
]);

/** Directory names that indicate a source root — never delete the dir itself. */
const SOURCE_DIRS = new Set([
  'src',
  'lib',
  'app',
  'pages',
  'components',
  'packages',
  'dist',
  'build',
  'test',
  'tests',
  '__tests__',
  'spec',
]);

/** Shell patterns that are always blocked. */
const DANGEROUS_SHELL_PATTERNS = [
  /rm\s+(-\w*[rR]\w*\s+)*(\/|~|\$HOME|\.\.|\.\/\.\.)/,  // rm -rf / or ~ or ..
  /rm\s+(-\w*[rR]\w*\s+)*\.\s*$/,                         // rm -rf .
  /rm\s+(-\w*[rR]\w*\s+)*\*\s*$/,                         // rm -rf *
  /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;/,                     // fork bomb
  /mkfs\./,                                                 // format filesystem
  /dd\s+.*of=\/dev\//,                                      // disk wipe
  />\s*\/dev\/sd/,                                          // overwrite disk
  /chmod\s+(-\w+\s+)*777\s+\//,                            // chmod 777 /
  /curl.*\|\s*(ba)?sh/,                                     // pipe curl to shell
  /wget.*\|\s*(ba)?sh/,                                     // pipe wget to shell
  /eval\s*\$\(/,                                            // eval command substitution
];

/** Commands that need extra scrutiny — require approval even if auto-approved. */
const HIGH_RISK_COMMANDS = [
  /\brm\s/,                    // ALL rm commands require explicit approval
  /\bunlink\s/,                // unlink
  /\brmdir\s/,                 // rmdir
  /git\s+push\s+--force/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-[fd]/,
  /drop\s+table/i,
  /drop\s+database/i,
  /truncate\s+table/i,
];

// ── Validation Functions ─────────────────────────────────────

/**
 * Check if a path is protected (should not be deleted/overwritten entirely).
 * @param {string} filePath - Absolute path
 * @param {string} cwd - Current working directory
 * @returns {{ safe: boolean, reason?: string }}
 */
export function validatePath(filePath, cwd = process.cwd()) {
  if (!filePath) return { safe: false, reason: 'Empty path' };

  const resolved = path.resolve(cwd, filePath);
  const basename = path.basename(resolved);
  const relative = path.relative(cwd, resolved);

  // Block anything outside CWD parent
  const cwdParent = path.dirname(cwd);
  if (!resolved.startsWith(cwdParent)) {
    return { safe: false, reason: `Path outside workspace: ${filePath}` };
  }

  // Block protected file names at any level
  if (PROTECTED_NAMES.has(basename) && !resolved.includes('node_modules/')) {
    return { safe: false, reason: `Protected path: ${basename}` };
  }

  return { safe: true };
}

/**
 * Check if a delete operation is safe.
 * Stricter than validatePath — also blocks source directories.
 * @param {string} filePath - Path to delete
 * @param {string} cwd - Current working directory
 * @returns {{ safe: boolean, reason?: string }}
 */
export function validateDelete(filePath, cwd = process.cwd()) {
  const pathCheck = validatePath(filePath, cwd);
  if (!pathCheck.safe) return pathCheck;

  const resolved = path.resolve(cwd, filePath);
  const basename = path.basename(resolved);

  // Never delete source root directories
  if (SOURCE_DIRS.has(basename)) {
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return { safe: false, reason: `Cannot delete source directory: ${basename}/` };
      }
    } catch { /* file doesn't exist, safe to proceed */ }
  }

  // Never delete CWD itself
  if (resolved === cwd || resolved === path.dirname(cwd)) {
    return { safe: false, reason: 'Cannot delete working directory' };
  }

  return { safe: true };
}

/**
 * Check if a shell command is safe to execute.
 * @param {string} command
 * @returns {{ safe: boolean, reason?: string, highRisk?: boolean }}
 */
export function validateShellCommand(command) {
  if (!command) return { safe: false, reason: 'Empty command' };

  // Always block dangerous patterns
  for (const pattern of DANGEROUS_SHELL_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `Blocked dangerous command: ${command.slice(0, 60)}` };
    }
  }

  // Flag high-risk commands (still allowed, but should force approval)
  for (const pattern of HIGH_RISK_COMMANDS) {
    if (pattern.test(command)) {
      return { safe: true, highRisk: true, reason: `High-risk command: ${command.slice(0, 60)}` };
    }
  }

  return { safe: true };
}

/**
 * Check if a write operation targets a sensible path.
 * @param {string} filePath
 * @param {string} content
 * @param {string} cwd
 * @returns {{ safe: boolean, reason?: string }}
 */
export function validateWrite(filePath, content, cwd = process.cwd()) {
  const pathCheck = validatePath(filePath, cwd);
  if (!pathCheck.safe) return pathCheck;

  const resolved = path.resolve(cwd, filePath);

  // Don't allow overwriting .git internals
  if (resolved.includes('/.git/')) {
    return { safe: false, reason: 'Cannot write to .git directory' };
  }

  // Warn if writing a very large file (> 1MB)
  if (content && content.length > 1_000_000) {
    return { safe: true, reason: `Large file write: ${(content.length / 1024).toFixed(0)}KB` };
  }

  return { safe: true };
}

/**
 * Get a human-readable summary of safety rules.
 */
export function getSafetyRules() {
  return {
    protectedNames: [...PROTECTED_NAMES],
    sourceDirs: [...SOURCE_DIRS],
    blockedPatterns: DANGEROUS_SHELL_PATTERNS.length,
    highRiskPatterns: HIGH_RISK_COMMANDS.length,
  };
}
