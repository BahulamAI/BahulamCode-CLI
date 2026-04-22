/**
 * Project Skeleton — lightweight codebase overview for LLM context.
 *
 * Generates a compact representation of the project:
 * - File tree (directories + file names)
 * - Function/class signatures extracted via regex (not full AST)
 *
 * Designed to be ~500-1000 tokens — gives the model a "map" so it knows
 * where to look without reading every file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.orca', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache', 'coverage', '.tox']);
const CODE_EXTS = new Set(['.js', '.mjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb', '.c', '.cpp', '.h']);
const MAX_FILE_SIZE = 200_000;

// Regex patterns for function/class signatures (multi-language)
const SIGNATURE_PATTERNS = [
  // Python: def/class/async def
  /^(?:async\s+)?(?:def|class)\s+(\w+)\s*[\(:].*$/gm,
  // JS/TS: function, class, export function, const fn =
  /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+))/gm,
  // Go: func
  /^func\s+(?:\(.*?\)\s+)?(\w+)\s*\(/gm,
  // Rust: fn, struct, impl
  /^(?:pub\s+)?(?:fn|struct|impl)\s+(\w+)/gm,
];

/**
 * Build a project skeleton — file tree + key signatures.
 * @param {string} projectDir
 * @param {Object} [options]
 * @param {number} [options.maxFiles=200] — max files to include
 * @param {number} [options.maxChars=4000] — max total chars (~1000 tokens)
 * @returns {string} — skeleton text for LLM context
 */
export function buildProjectSkeleton(projectDir, { maxFiles = 200, maxChars = 4000 } = {}) {
  const files = scanFiles(projectDir, 0, maxFiles);
  if (files.length === 0) return '';

  const parts = [];
  parts.push(`Project: ${path.basename(projectDir)} (${files.length} source files)`);
  parts.push('');

  // Group by directory
  const dirs = new Map();
  for (const f of files) {
    const rel = path.relative(projectDir, f);
    const dir = path.dirname(rel);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(rel);
  }

  // File tree
  parts.push('## File Tree');
  for (const [dir, dirFiles] of dirs) {
    parts.push(`${dir}/`);
    for (const f of dirFiles) {
      parts.push(`  ${path.basename(f)}`);
    }
  }

  // Key signatures (top-level functions/classes)
  parts.push('');
  parts.push('## Key Signatures');

  let sigCount = 0;
  for (const f of files) {
    if (sigCount > 50) break; // Cap signatures
    try {
      const content = fs.readFileSync(f, 'utf-8');
      const rel = path.relative(projectDir, f);
      const sigs = extractSignatures(content);
      if (sigs.length > 0) {
        parts.push(`${rel}: ${sigs.join(', ')}`);
        sigCount += sigs.length;
      }
    } catch { /* skip */ }
  }

  let skeleton = parts.join('\n');
  if (skeleton.length > maxChars) {
    skeleton = skeleton.slice(0, maxChars) + '\n... (truncated)';
  }
  return skeleton;
}

/**
 * Extract function/class names from source code via regex.
 */
function extractSignatures(content) {
  const names = new Set();
  for (const pattern of SIGNATURE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      // Take the first non-null capture group
      const name = match[1] || match[2] || match[3];
      if (name && !name.startsWith('_')) names.add(name);
    }
  }
  return Array.from(names).slice(0, 10);
}

/**
 * Scan project for source files.
 */
function scanFiles(dir, depth = 0, maxFiles = 200) {
  if (depth > 10) return [];
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanFiles(fullPath, depth + 1, maxFiles - results.length));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!CODE_EXTS.has(ext)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
      } catch { continue; }
      results.push(fullPath);
    }
  }
  return results;
}
