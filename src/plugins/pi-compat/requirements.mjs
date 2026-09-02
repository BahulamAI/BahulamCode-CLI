/**
 * Static requirements analyzer for an installed pi ingredient.
 *
 * Walks the package's source files and detects the failure-mode signals
 * a composed pack will hit at first tool call: shell binaries the pi
 * package spawns, env vars / API keys it reads, workspace-scoping of
 * paths, and per-tool schema constraints already surfaced by the probe.
 *
 * Emits `<pi-dir>/.bahulam-requirements.json` alongside the tool cache.
 * Runs after `discoverPiTools` during pull/install so the CLI can print
 * findings before the user commits to using the pack.
 *
 * Explicitly not-an-LLM: uses regex + JSON reads + Markdown section
 * matching. Fast (< 500ms for a big package), safe, no network. If a
 * requirement slips past the static heuristics, the user pastes the
 * error into Bahulam and the main agent reasons about it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export const REQUIREMENTS_FILE = '.bahulam-requirements.json';

// Known binary → install hint DB. Extend as we learn new pi packages.
// Keep it small and honest: unknown binaries just report the name.
const INSTALL_HINTS = {
  ffmpeg:      { darwin: 'brew install ffmpeg',         linux: 'apt install -y ffmpeg' },
  ffprobe:     { darwin: 'brew install ffmpeg',         linux: 'apt install -y ffmpeg' },
  imagemagick: { darwin: 'brew install imagemagick',    linux: 'apt install -y imagemagick' },
  convert:     { darwin: 'brew install imagemagick',    linux: 'apt install -y imagemagick' },
  magick:      { darwin: 'brew install imagemagick',    linux: 'apt install -y imagemagick' },
  docker:      { darwin: 'brew install --cask docker',  linux: 'https://docs.docker.com/engine/install/' },
  git:         { darwin: 'brew install git',            linux: 'apt install -y git' },
  python:      { darwin: 'brew install python',         linux: 'apt install -y python3' },
  python3:     { darwin: 'brew install python',         linux: 'apt install -y python3' },
  node:        { darwin: 'brew install node',           linux: 'apt install -y nodejs' },
  yt_dlp:      { darwin: 'brew install yt-dlp',         linux: 'pip install yt-dlp' },
  'yt-dlp':    { darwin: 'brew install yt-dlp',         linux: 'pip install yt-dlp' },
  pandoc:      { darwin: 'brew install pandoc',         linux: 'apt install -y pandoc' },
  tesseract:   { darwin: 'brew install tesseract',      linux: 'apt install -y tesseract-ocr' },
};

// Shell keywords that mean "the arg after me is the binary" when
// child_process is invoked with a shell wrapper like `sh -c '...'`.
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'pwsh']);

// Env var names we treat as "credential-ish" by heuristic. Not exhaustive —
// falls back to any UPPER_SNAKE ending in these tokens.
const CREDENTIAL_SUFFIXES = ['_KEY', '_TOKEN', '_SECRET', '_PASSWORD', '_APIKEY', '_API_KEY', '_ACCESS_KEY', '_ACCESS_TOKEN'];

// Files we scan. .ts/.mjs/.js/.cjs — pi packages sometimes ship pure TS.
const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/;

// Directories we skip (bloat + third-party code we don't want to attribute
// as pi's requirements).
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'tests', '__tests__', 'test']);

// Cap the scan so an accidentally-huge package doesn't hang.
const MAX_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024; // skip anything > 512KB (minified bundles)

function walkSources(dir, out, budget) {
  if (out.length >= MAX_FILES) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walkSources(full, out, budget);
    } else if (entry.isFile() && SOURCE_EXT_RE.test(entry.name)) {
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        out.push(full);
      } catch { /* skip */ }
    }
  }
}

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

/**
 * Extract the binary name from a spawn/exec/execFile call. Handles:
 *   spawn('ffmpeg', ...)         → ffmpeg
 *   spawn("bash", ["-c", "ff"])  → ffmpeg (peek shell args)
 *   exec('ffprobe -v error ...') → ffprobe
 *   execFile("./bin/foo", ...)   → foo (skip — local script, not a system dep)
 *   spawn(cmd, ...)              → skipped (variable, we can't infer)
 */
function extractBinaryFromCall(callKind, argText) {
  const trimmed = argText.trim();
  const m = trimmed.match(/^(['"`])(.+?)\1/);
  if (!m) return null;
  let first = m[2].trim();

  if (callKind === 'exec' || callKind === 'execSync') {
    // First token of a shell command line.
    const token = first.split(/\s+/)[0] || '';
    const clean = token.replace(/^['"]|['"]$/g, '');
    const base = path.basename(clean).replace(/\.(exe|bat|cmd)$/i, '');
    if (!base || base.startsWith('/') || base.startsWith('.') || base.startsWith('$')) return null;
    if (!/^[a-zA-Z0-9_.+-]+$/.test(base)) return null;
    return base;
  }
  if (callKind === 'spawn' || callKind === 'spawnSync' || callKind === 'execFile' || callKind === 'execFileSync') {
    const base = path.basename(first).replace(/\.(exe|bat|cmd)$/i, '');
    if (!base || first.startsWith('./') || first.startsWith('../') || first.startsWith('/')) {
      // Local path — a bundled script, not a system requirement
      return null;
    }
    if (!/^[a-zA-Z0-9_.+-]+$/.test(base)) return null;
    // Special-case shell wrappers: peek the args array for the real binary
    if (SHELL_WRAPPERS.has(base)) {
      const argsMatch = trimmed.match(/,\s*\[(.*?)\]/s);
      if (argsMatch) {
        const argsText = argsMatch[1];
        // Look for the first quoted arg after a "-c" flag
        const cMatch = argsText.match(/['"`]-c['"`]\s*,\s*['"`]([^'"`]+)['"`]/);
        if (cMatch) {
          const innerBin = cMatch[1].trim().split(/\s+/)[0] || '';
          const innerBase = path.basename(innerBin).replace(/\.(exe|bat|cmd)$/i, '');
          if (innerBase && /^[a-zA-Z0-9_.+-]+$/.test(innerBase)) return innerBase;
        }
      }
      return null;
    }
    return base;
  }
  return null;
}

/**
 * Scan a single source file for shell/env/path signals. Purely textual —
 * we skip AST parsing to keep the analyzer dependency-free and fast.
 * False positives are acceptable; the alternative (missing a real dep)
 * is worse. Users see a list they can eyeball.
 */
// Binary names we recognize in string literals or env var infixes when
// direct spawn arg detection misses (spawn(variable, ...) is common).
const KNOWN_BINARY_TOKENS = ['ffmpeg', 'ffprobe', 'imagemagick', 'convert', 'magick', 'docker', 'git', 'python', 'python3', 'node', 'yt-dlp', 'ytdlp', 'pandoc', 'tesseract', 'sox', 'gs', 'ghostscript', 'poppler', 'pdftotext', 'pdfinfo', 'lame', 'oggenc', 'flac', 'curl', 'wget', 'rsync', 'jq', 'yq', 'awk', 'sed'];

function analyzeFile(text, rel, findings) {
  // Shell binary calls: spawn/spawnSync/exec/execSync/execFile/execFileSync
  const shellRe = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*([^)]{0,300})\)/g;
  let m;
  let sawChildProcess = /\bfrom\s*['"]node:child_process['"]|require\(\s*['"]node:child_process['"]/.test(text)
    || /\bfrom\s*['"]child_process['"]|require\(\s*['"]child_process['"]/.test(text);
  while ((m = shellRe.exec(text)) !== null) {
    sawChildProcess = true;
    const kind = m[1];
    const bin = extractBinaryFromCall(kind, m[2]);
    if (!bin) continue;
    const existing = findings.systemBinaries.get(bin) || { name: bin, seen_in: new Set() };
    existing.seen_in.add(rel);
    findings.systemBinaries.set(bin, existing);
  }

  // Env vars: process.env.XXX or process.env['XXX']
  const envRe = /\bprocess\.env\s*(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]\s*\])/g;
  while ((m = envRe.exec(text)) !== null) {
    const name = m[1] || m[2];
    if (!name) continue;
    // Ignore Node.js / OS-level env vars users don't set for a plugin.
    if (['NODE_ENV', 'PATH', 'HOME', 'USER', 'PWD', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TMP', 'TEMP'].includes(name)) continue;
    const existing = findings.envVars.get(name) || { name, seen_in: new Set(), credential: false };
    existing.seen_in.add(rel);
    if (CREDENTIAL_SUFFIXES.some(s => name.endsWith(s))) existing.credential = true;
    findings.envVars.set(name, existing);

    // If an env var name contains a known binary token (e.g. PI_MEDIA_FFMPEG_BINARY,
    // FFPROBE_PATH, IMAGEMAGICK_HOME), the package is almost certainly
    // shelling out to that binary — even when the actual spawn() takes a
    // variable, not a literal. This catches the common override-your-binary
    // pattern many pi packages use.
    const lower = name.toLowerCase();
    for (const tok of KNOWN_BINARY_TOKENS) {
      if (lower.includes(tok.replace('-', '_'))) {
        const existing2 = findings.systemBinaries.get(tok) || { name: tok, seen_in: new Set() };
        existing2.seen_in.add(`inferred from env var ${name}`);
        findings.systemBinaries.set(tok, existing2);
      }
    }
  }

  // Fallback: if child_process is imported but spawn args are variables
  // (spawn(cmd, ...)) rather than literals, look for known binary names as
  // string literals anywhere in the file. False-positive risk (a comment or
  // an error message could mention 'ffmpeg'), but the alternative is
  // missing the requirement entirely — users can review the findings list.
  if (sawChildProcess && findings.systemBinaries.size === 0) {
    for (const tok of KNOWN_BINARY_TOKENS) {
      const litRe = new RegExp(`['"\`]${tok.replace(/[-]/g, '\\-')}['"\`]`, 'i');
      if (litRe.test(text)) {
        const existing = findings.systemBinaries.get(tok) || { name: tok, seen_in: new Set() };
        existing.seen_in.add(`literal in ${rel}`);
        findings.systemBinaries.set(tok, existing);
      }
    }
  }

  // Workspace-scoping heuristic: the pi convention is `ctx.cwd` used in a
  // path resolve/join, followed by a throw about "outside" or "workspace".
  if (!findings.workspaceScopedPaths) {
    if (/ctx\s*\.\s*cwd/.test(text) && /(outside|not.*inside|workspace)/i.test(text) && /throw\b/.test(text)) {
      findings.workspaceScopedPaths = true;
    }
  }
}

function analyzePackageJson(pkg, findings) {
  // Author-declared runtime hints.
  const opt = pkg.optionalDependencies || {};
  for (const name of Object.keys(opt)) {
    // Heuristic: optionalDependencies named after known binaries.
    if (INSTALL_HINTS[name]) {
      const existing = findings.systemBinaries.get(name) || { name, seen_in: new Set(['package.json:optionalDependencies']) };
      findings.systemBinaries.set(name, existing);
    }
  }
  // engines / os could add platform hints — record but don't overweight.
  if (pkg.engines) findings.enginesRequirement = pkg.engines;
  if (pkg.os) findings.osRequirement = pkg.os;
  if (pkg.cpu) findings.cpuRequirement = pkg.cpu;
}

function extractReadmeSections(readmeText) {
  if (!readmeText) return [];
  const sections = [];
  const wanted = /^\s*#{1,3}\s+(requirements?|prerequisites?|installation|setup|dependencies|before you begin)\b/i;
  const lines = readmeText.split('\n');
  let inSection = false;
  let title = '';
  let body = [];
  const flush = () => {
    if (inSection) {
      const text = body.join('\n').trim();
      if (text) sections.push({ title: title.trim(), body: text.slice(0, 2000) });
    }
    inSection = false; title = ''; body = [];
  };
  for (const line of lines) {
    if (wanted.test(line)) {
      flush();
      inSection = true;
      title = line.replace(/^\s*#+\s*/, '');
      continue;
    }
    if (inSection && /^\s*#{1,3}\s/.test(line)) { flush(); continue; }
    if (inSection) body.push(line);
  }
  flush();
  return sections;
}

function extractSkillsFiles(pluginDir) {
  const skills = [];
  const dirs = ['skills', 'SKILLS'];
  for (const d of dirs) {
    const full = path.join(pluginDir, d);
    try {
      const stat = fs.statSync(full);
      if (!stat.isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (/\.(md|markdown|mdx)$/i.test(f)) skills.push(path.join(d, f));
      }
    } catch { /* skip */ }
  }
  // Root-level SKILL.md
  for (const name of ['SKILL.md', 'skill.md', 'AGENTS.md']) {
    if (fs.existsSync(path.join(pluginDir, name))) skills.push(name);
  }
  return skills;
}

function extractToolConstraints(discoveredTools) {
  const out = {};
  for (const tool of discoveredTools || []) {
    const s = tool.input_schema || {};
    const props = s.properties || {};
    const required = new Set(s.required || []);
    const perParam = {};
    for (const [name, def] of Object.entries(props)) {
      const c = {};
      if (def.pattern) c.regex = def.pattern;
      if (typeof def.minLength === 'number') c.min_length = def.minLength;
      if (typeof def.maxLength === 'number') c.max_length = def.maxLength;
      if (typeof def.minimum === 'number') c.min = def.minimum;
      if (typeof def.maximum === 'number') c.max = def.maximum;
      if (Array.isArray(def.enum)) c.enum = def.enum;
      if (required.has(name)) c.required = true;
      if (Object.keys(c).length) perParam[name] = c;
    }
    if (Object.keys(perParam).length) out[tool.name] = perParam;
  }
  return out;
}

/**
 * Analyze an installed pi ingredient. Returns the requirements object
 * AND writes it to `<pluginDir>/.bahulam-requirements.json`.
 *
 * @param {string} pluginDir — absolute path to the ingredient dir
 * @param {Object} [opts]
 * @param {Object} [opts.discoveredTools] — parsed .bahulam-tools.json, if
 *   the caller already has it. Otherwise skips tool-constraint extraction.
 */
export function analyzeRequirements(pluginDir, { discoveredTools = null } = {}) {
  const findings = {
    systemBinaries: new Map(),
    envVars: new Map(),
    workspaceScopedPaths: false,
    enginesRequirement: null,
    osRequirement: null,
    cpuRequirement: null,
  };

  // Package.json hints
  const pkgPath = path.join(pluginDir, 'package.json');
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { /* skip */ }
  analyzePackageJson(pkg, findings);

  // Walk sources
  const files = [];
  walkSources(pluginDir, files, MAX_FILES);
  for (const abs of files) {
    const rel = path.relative(pluginDir, abs);
    analyzeFile(readTextSafe(abs), rel, findings);
  }

  // README requirements
  const readmeCandidates = ['README.md', 'readme.md', 'README', 'readme.markdown'];
  let readmeText = '';
  for (const r of readmeCandidates) {
    const full = path.join(pluginDir, r);
    if (fs.existsSync(full)) { readmeText = readTextSafe(full); break; }
  }
  const readmeSections = extractReadmeSections(readmeText);

  // Skills discovery
  const skills = extractSkillsFiles(pluginDir);

  // Tool constraints from probed schemas (caller supplies)
  const toolConstraints = discoveredTools ? extractToolConstraints(discoveredTools.tools || []) : {};

  // Assemble the sidecar
  const shape = {
    version: 1,
    analyzed_at: new Date().toISOString(),
    files_scanned: files.length,
    truncated: files.length >= MAX_FILES,
    system_binaries: [...findings.systemBinaries.values()]
      .map(v => ({
        name: v.name,
        install_hints: INSTALL_HINTS[v.name] || null,
        seen_in: [...v.seen_in].slice(0, 5),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    env_vars: [...findings.envVars.values()]
      .map(v => ({
        name: v.name,
        credential: v.credential,
        seen_in: [...v.seen_in].slice(0, 5),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    workspace_scoped_paths: findings.workspaceScopedPaths,
    engines: findings.enginesRequirement,
    os: findings.osRequirement,
    cpu: findings.cpuRequirement,
    readme_sections: readmeSections,
    skills_available: skills,
    tool_constraints: toolConstraints,
  };

  try {
    fs.writeFileSync(path.join(pluginDir, REQUIREMENTS_FILE), JSON.stringify(shape, null, 2));
  } catch { /* non-fatal; findings still returned to caller */ }

  return shape;
}

/**
 * Format a requirements report for terminal output. Compact, actionable,
 * no color codes (caller adds ANSI wrappers around specific tokens).
 * Returns an array of {level, text} lines: level ∈ 'info' | 'warn' | 'ok'.
 */
export function formatRequirementsReport(reqs, { verbose = false } = {}) {
  const lines = [];
  if (!reqs) return lines;

  if (reqs.system_binaries?.length) {
    lines.push({ level: 'warn', text: `system binaries required: ${reqs.system_binaries.map(b => b.name).join(', ')}` });
    if (verbose) {
      for (const b of reqs.system_binaries) {
        const hint = b.install_hints?.darwin || b.install_hints?.linux;
        lines.push({ level: 'info', text: `   ${b.name}${hint ? ` — install: ${hint}` : ''}` });
      }
    }
  }
  if (reqs.env_vars?.length) {
    const creds = reqs.env_vars.filter(v => v.credential);
    const other = reqs.env_vars.filter(v => !v.credential);
    if (creds.length) lines.push({ level: 'warn', text: `API keys / credentials: ${creds.map(v => v.name).join(', ')}` });
    if (other.length && verbose) lines.push({ level: 'info', text: `other env vars: ${other.map(v => v.name).join(', ')}` });
  }
  if (reqs.workspace_scoped_paths) {
    lines.push({ level: 'info', text: 'paths must be workspace-relative (relative to cwd)' });
  }
  if (reqs.readme_sections?.length) {
    lines.push({ level: 'info', text: `README notes ${reqs.readme_sections.length} section(s): ${reqs.readme_sections.map(s => s.title).join(', ')}` });
  }
  if (reqs.skills_available?.length) {
    lines.push({ level: 'info', text: `skills available: ${reqs.skills_available.join(', ')}` });
  }
  if (!lines.length) {
    lines.push({ level: 'ok', text: 'no external requirements detected — pure JS/TS + npm deps' });
  }
  return lines;
}

/**
 * Check requirements against the host environment. Used by `plugin doctor`.
 * Returns per-item results — caller prints and decides exit code.
 */
export function checkRequirementsAgainstHost(reqs) {
  const results = { binaries: [], env_vars: [] };

  const isWin = process.platform === 'win32';
  const whichCmd = isWin ? 'where' : 'command -v';
  for (const b of reqs?.system_binaries || []) {
    let found = false, resolvedPath = null, version = null;
    try {
      const out = execSync(`${whichCmd} ${b.name}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: isWin ? undefined : '/bin/sh',
      }).trim();
      resolvedPath = out.split(/\r?\n/)[0] || null;
      found = Boolean(resolvedPath);
    } catch { found = false; }
    if (found) {
      try {
        version = execSync(`${b.name} --version`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).split(/\r?\n/)[0].trim();
      } catch { /* skip */ }
    }
    results.binaries.push({ name: b.name, found, path: resolvedPath, version, install_hints: b.install_hints });
  }

  for (const v of reqs?.env_vars || []) {
    const value = process.env[v.name];
    results.env_vars.push({ name: v.name, credential: v.credential, set: Boolean(value && value.length) });
  }

  return results;
}

