import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ContextRetriever } from '../context/retriever.mjs';
import { buildProjectSkeleton } from '../context/skeleton.mjs';
import { indexDir as getIndexDir, projectConfigDir, bahulamHome } from '../core/paths.mjs';

const RESOURCE_FILE = 'project-resource.json';

/**
 * Expand "~" and trim surrounding quotes/whitespace. Does NOT unescape shell
 * meta characters — that is a separate, last-resort step done only if the
 * literal path does not resolve.
 */
function normalizePathInput(p) {
    let s = String(p || '').trim();
    // Trim balanced surrounding quotes.
    if ((s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1);
    }
    // Tilde expansion (~ or ~/...).
    if (s === '~' || s.startsWith('~/')) {
        s = path.join(os.homedir(), s.slice(1));
    }
    return s;
}

/**
 * Replace common shell escape sequences with their literal characters. Used
 * as a fallback when the literal path does not resolve — the agent may have
 * pasted a copy of what they would type at a shell prompt.
 */
function unescapeShellPath(p) {
    return String(p || '').replace(/\\([ \t()&$;'"])/g, '$1');
}

const LANGUAGE_EXTENSIONS = new Map([
    ['.py', 'Python'],
    ['.js', 'JavaScript'],
    ['.mjs', 'JavaScript'],
    ['.ts', 'TypeScript'],
    ['.tsx', 'TypeScript'],
    ['.go', 'Go'],
    ['.rs', 'Rust'],
    ['.java', 'Java'],
    ['.rb', 'Ruby'],
    ['.c', 'C'],
    ['.cpp', 'C++'],
]);
const IGNORED_DIRS = new Set([
    '.git', '.bahulam', '.next', '.venv', '__pycache__',
    'build', 'dist', 'node_modules', 'venv',
]);
const ENV_PROBE_TIMEOUT_MS = Math.max(
    50,
    Number(process.env.BAHULAM_ENV_PROBE_TIMEOUT_MS || 500) || 500,
);

// Files or directories whose presence at the root implies this IS a project.
// One is enough. Kept broad so we accept Node/Python/Rust/Go/Ruby/Java/C++
// projects, container-only repos, and Bahulam/agent-configured directories.
const PROJECT_MARKERS = [
    '.git', '.hg', '.svn',
    '.bahulam', '.kepler',        // Bahulam project state
    'package.json',                // Node
    'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile',
    'Cargo.toml',                  // Rust
    'go.mod',                      // Go
    'Gemfile',                     // Ruby
    'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',  // Java/Kotlin
    'Makefile', 'CMakeLists.txt',  // C/C++
    'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
    'AGENTS.md', 'CLAUDE.md', 'KEPLER.md',  // Agent config lives at root
    '.editorconfig',               // Broad but a strong "this is a repo" signal
];

// System / user-home roots we refuse outright — indexing these would sweep
// every project the user has ever touched and produce noise, not signal.
// Compared per-realpath so symlinks don't sneak past.
function _dangerousRootSet() {
    const set = new Set([
        '/', '/tmp', '/var', '/etc', '/usr', '/opt',
        '/Applications', '/Library', '/System',
        '/Users', '/home', '/root',
        '/Volumes', '/mnt', '/media',
    ]);
    try { set.add(os.homedir()); } catch {}
    try { set.add(path.parse(os.homedir()).root); } catch {}
    return set;
}

function isDangerousRoot(root) {
    return _dangerousRootSet().has(root);
}

function hasProjectMarkers(root) {
    for (const marker of PROJECT_MARKERS) {
        try {
            if (fs.existsSync(path.join(root, marker))) return true;
        } catch { /* skip unreadable entries */ }
    }
    return false;
}

function projectId(canonicalPath) {
    return crypto.createHash('sha256').update(canonicalPath).digest('hex').slice(0, 12);
}

function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueValues(values) {
    return [...new Set(values.filter(Boolean))];
}

function canonicalRoot(rootPath) {
    const resolved = path.resolve(normalizePathInput(rootPath));
    try {
        return fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

function canonicalizeCandidate(candidate) {
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);

    const missing = [];
    let parent = candidate;
    while (!fs.existsSync(parent)) {
        const next = path.dirname(parent);
        if (next === parent) break;
        missing.unshift(path.basename(parent));
        parent = next;
    }
    return path.join(fs.realpathSync(parent), ...missing);
}

function projectFingerprint(projectDir) {
    const hash = crypto.createHash('sha256');
    const queue = [projectDir];

    while (queue.length > 0) {
        const dir = queue.shift();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                queue.push(fullPath);
                continue;
            }
            if (!entry.isFile()) continue;
            try {
                const stat = fs.statSync(fullPath);
                hash.update(
                    `${path.relative(projectDir, fullPath)}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`
                );
            } catch { /* file changed during scan */ }
        }
    }
    return hash.digest('hex').slice(0, 16);
}

function detectLanguages(projectDir) {
    const counts = new Map();
    const queue = [projectDir];
    let scanned = 0;

    while (queue.length > 0 && scanned < 500) {
        const dir = queue.shift();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (scanned >= 500) break;
            if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                queue.push(fullPath);
            } else if (entry.isFile()) {
                scanned++;
                const language = LANGUAGE_EXTENSIONS.get(path.extname(entry.name));
                if (language) counts.set(language, (counts.get(language) || 0) + 1);
            }
        }
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([language]) => language);
}

function detectCommands(projectDir) {
    const commands = {};
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
        if (pkg.scripts?.test) commands.test = 'npm test';
        if (pkg.scripts?.build) commands.build = 'npm run build';
        if (pkg.scripts?.lint) commands.lint = 'npm run lint';
    } catch { /* no package.json */ }

    if (
        fs.existsSync(path.join(projectDir, 'pyproject.toml')) ||
        fs.existsSync(path.join(projectDir, 'setup.py'))
    ) {
        if (!commands.test) commands.test = 'python -m pytest';
    }
    if (fs.existsSync(path.join(projectDir, 'Makefile')) && !commands.build) {
        commands.build = 'make';
    }
    return commands;
}

function commandVersion(command, args = ['--version']) {
    try {
        const result = spawnSync(command, args, {
            encoding: 'utf-8',
            timeout: ENV_PROBE_TIMEOUT_MS,
            windowsHide: true,
        });
        if (result.error || result.status !== 0) return '';
        return `${result.stdout || result.stderr || ''}`.trim().split('\n')[0].slice(0, 120);
    } catch {
        return '';
    }
}

function detectEnvironment() {
    const candidates = [
        ['python', 'python3'],
        ['node', 'node'],
        ['git', 'git'],
        ['npm', 'npm'],
        ['uv', 'uv'],
        ['docker', 'docker'],
    ];
    const tools = {};
    for (const [name, command] of candidates) {
        const version = commandVersion(command);
        if (version) tools[name] = version;
    }
    return {
        platform: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        shell: process.env.SHELL || process.env.ComSpec || '',
        node: process.version,
        tools,
    };
}

function formatResource(resource) {
    const lines = [
        `Project registered: ${resource.name} (project_id=${resource.project_id})`,
        `Root: ${resource.root}`,
        `Languages: ${resource.languages.join(', ') || 'unknown'}`,
        `Index: ${resource.index_status} (${resource.index_version})`,
    ];
    if (resource.environment) {
        const env = resource.environment;
        lines.push(
            `Environment: ${env.platform || 'unknown'} ${env.release || ''} ` +
            `(${env.architecture || 'unknown'}), shell=${env.shell || 'unknown'}, node=${env.node || 'unknown'}`
        );
        const toolVersions = Object.entries(env.tools || {});
        if (toolVersions.length > 0) {
            lines.push(`Available tools: ${toolVersions.map(([name, version]) =>
                `${name}=${version}`).join(', ')}`);
        }
    }
    if (Object.keys(resource.commands).length > 0) {
        lines.push(`Commands: ${Object.entries(resource.commands)
            .map(([name, command]) => `${name}="${command}"`).join(', ')}`);
    }
    if (resource.skills_index && resource.skills_index.length > 0) {
        lines.push(`Skills: ${resource.skills_index.map(s => s.name).join(', ')}`);
    }
    lines.push('', resource.overview);
    if (resource.project_context) {
        lines.push('', '--- Project Context ---', resource.project_context);
    }
    if (resource.style) {
        lines.push('', '--- Project Style ---', resource.style);
    }
    if (resource.goal) {
        lines.push('', '--- Current Goal ---', resource.goal);
    }
    if (resource.plan) {
        lines.push('', '--- Current Plan ---', resource.plan);
    }
    return lines.join('\n');
}

function _readIfExists(dir, filename, maxChars = 8000) {
    try {
        const filePath = path.join(dir, filename);
        if (!fs.existsSync(filePath)) return '';
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.length > maxChars) {
            // 70/20 head/tail truncation
            const head = Math.floor(maxChars * 0.7);
            const tail = Math.floor(maxChars * 0.2);
            return content.slice(0, head) + '\n\n[...truncated...]\n\n' + content.slice(-tail);
        }
        return content;
    } catch { return ''; }
}

function _scanSkills(bahulamDir) {
    const skillsDir = path.join(bahulamDir, 'skills');
    if (!fs.existsSync(skillsDir)) return [];
    try {
        return fs.readdirSync(skillsDir, { withFileTypes: true })
            .map(entry => {
                const file = entry.isDirectory()
                    ? path.join(skillsDir, entry.name, 'SKILL.md')
                    : path.join(skillsDir, entry.name);
                if (!fs.existsSync(file) || !file.endsWith('.md')) return null;
                const content = fs.readFileSync(file, 'utf-8');
                const descMatch = content.match(/^#\s+.*\n+(.+)/);
                return {
                    name: entry.isDirectory() ? entry.name : entry.name.replace('.md', ''),
                    description: content.match(/^description:\s*(.+)$/mi)?.[1]?.trim()
                        || (descMatch ? descMatch[1].slice(0, 100) : entry.name.replace('.md', '')),
                };
            })
            .filter(Boolean);
    } catch { return []; }
}

function defaultScratchRoots() {
    return uniqueValues([
        '/tmp',
        '/private/tmp',
        os.tmpdir(),
        process.env.TMPDIR,
        ...(process.env.KEPLER_SCRATCH_ROOTS || '')
            .split(path.delimiter)
            .map(s => s.trim())
            .filter(Boolean),
    ]).map(canonicalRoot);
}

export class ProjectRegistry {
    constructor() {
        this.projects = new Map();
        this.scratchRoots = new Set(defaultScratchRoots());
        this._globalIdentity = null;
        this._globalPreferences = null;
        this._globalSkills = null;
    }

    addScratchRoot(rawPath) {
        if (!rawPath) return null;
        const root = canonicalRoot(rawPath);
        this.scratchRoots.add(root);
        return root;
    }

    /**
     * Load global context from ~/.bahulam/ (once per session).
     */
    loadGlobalContext() {
        if (this._globalIdentity !== null) return;
        // Resolver — prefers ~/.bahulam, falls back to ~/.kepler for legacy installs.
        const globalDir = bahulamHome();
        this._globalIdentity = _readIfExists(globalDir, 'identity.md', 4000);
        this._globalPreferences = _readIfExists(globalDir, 'preferences.md', 2000);
        this._globalSkills = _scanSkills(globalDir);
    }

    /**
     * Get the global agent context (identity, preferences, skills).
     */
    getGlobalContext() {
        this.loadGlobalContext();
        return {
            identity: this._globalIdentity || '',
            preferences: this._globalPreferences || '',
            skills: this._globalSkills || [],
        };
    }

    // PRD-69 project context is live metadata, not index cache. Re-read it on
    // every registration attempt so repeated get_project_overview calls pick up
    // .bahulam/KEPLER.md, goal/plan/style, skills, AGENTS.md, etc. changes.
    _attachLiveContext(resource, root) {
        // Resolver — prefers .bahulam/, falls back to .kepler/ for legacy projects.
        const bahulamDir = projectConfigDir(root);
        resource.environment = detectEnvironment();
        resource.project_context = _readIfExists(bahulamDir, 'KEPLER.md', 10000) ||
            _readIfExists(root, 'KEPLER.md', 10000) ||
            _readIfExists(bahulamDir, 'project.md', 8000);
        resource.style = _readIfExists(bahulamDir, 'style.md', 4000);
        resource.goal = _readIfExists(bahulamDir, 'goal.md', 2000);
        resource.plan = _readIfExists(bahulamDir, 'plan.md', 6000);
        resource.skills_index = _scanSkills(bahulamDir);

        if (!resource.project_context) {
            for (const name of ['.bahulam.md', 'AGENTS.md', 'CLAUDE.md']) {
                const content = _readIfExists(root, name, 8000);
                if (content) { resource.project_context = content; break; }
            }
        }
        return resource;
    }

    async register(rawPath, { forceRefresh = false, force_refresh = false, bypassProjectMarkers = false } = {}) {
        if (!rawPath) {
            throw new Error('get_project_overview requires a project path');
        }

        // LLM sometimes passes shell-escaped paths ("Bahulam") or paths
        // beginning with "~". Normalize defensively so the tool does not bounce
        // back a "not found" error on a path that's correct apart from quoting.
        rawPath = normalizePathInput(rawPath);

        if (!path.isAbsolute(rawPath)) {
            rawPath = path.resolve(process.cwd(), rawPath);
        }

        let root;
        try {
            root = fs.realpathSync(rawPath);
        } catch {
            // Try the unescaped variant explicitly so the error message can
            // tell the agent what it actually attempted.
            const unescaped = unescapeShellPath(rawPath);
            if (unescaped !== rawPath) {
                try { root = fs.realpathSync(unescaped); }
                catch { throw new Error(`Project path not found: ${rawPath} (also tried ${unescaped})`); }
            } else {
                throw new Error(`Project path not found: ${rawPath}`);
            }
        }
        if (!fs.statSync(root).isDirectory()) {
            throw new Error(`Project path is not a directory: ${root}`);
        }
        if (isDangerousRoot(root)) {
            throw new Error(
                `Refusing to index ${root} — too broad or system-level. ` +
                `Pass a specific project directory, or answer the user's question ` +
                `without get_project_overview if it doesn't need project files.`
            );
        }
        // Programmatic file-read registration (registerFileRead) bypasses the
        // marker check — the user has a specific file in hand and we index its
        // parent so tool guards don't block the read. The user-facing
        // get_project_overview tool DOES enforce the check.
        if (!bypassProjectMarkers && !hasProjectMarkers(root)) {
            throw new Error(
                `No project markers found at ${root} (checked for .git, package.json, ` +
                `pyproject.toml, Cargo.toml, go.mod, Gemfile, pom.xml, Makefile, ` +
                `Dockerfile, AGENTS.md, .bahulam/). If the user's request does not ` +
                `require this codebase, do NOT call get_project_overview again for ` +
                `this session — answer the question directly. If it does require code, ` +
                `ask the user to point at the correct project directory.`
            );
        }

        const id = projectId(root);
        const fingerprint = projectFingerprint(root);
        const existing = this.projects.get(id);
        const shouldForceRefresh = Boolean(forceRefresh || force_refresh);
        if (existing && !shouldForceRefresh && existing.resource.index_version === fingerprint) {
            this._attachLiveContext(existing.resource, root);
            return {
                already_registered: true,
                refreshed: false,
                resource: existing.resource,
                output:
                    `Project already registered as project_id=${id}. ` +
                    `Use project_id=${id} with search_code and use absolute paths for file tools.`,
            };
        }

        const retriever = new ContextRetriever(root);
        const resourcePath = path.join(getIndexDir(root), RESOURCE_FILE);
        let resource = null;

        try {
            const persisted = JSON.parse(fs.readFileSync(resourcePath, 'utf-8'));
            if (!shouldForceRefresh && persisted.index_version === fingerprint && retriever.loadIndex()) {
                resource = persisted;
            }
        } catch { /* missing or stale index */ }

        if (!resource) {
            await retriever.buildIndex();
            resource = {
                project_id: id,
                root,
                name: path.basename(root),
                languages: detectLanguages(root),
                commands: detectCommands(root),
                overview: buildProjectSkeleton(root, { maxFiles: 150, maxChars: 2500 }) ||
                    `Project at ${root}`,
                index_status: 'ready',
                index_version: fingerprint,
            };
            fs.writeFileSync(resourcePath, JSON.stringify(resource));
        }

        this._attachLiveContext(resource, root);
        this.projects.set(id, { resource, retriever });
        const refreshed = Boolean(existing);
        return {
            already_registered: refreshed,
            refreshed,
            resource,
            output: refreshed
                ? `Project refreshed: ${resource.name} (project_id=${id})\nRoot: ${resource.root}`
                : formatResource(resource),
        };
    }

    resources() {
        return [...this.projects.values()].map(({ resource }) => resource);
    }

    get(projectIdValue) {
        return this.projects.get(projectIdValue) || null;
    }

    projectScratchRoots() {
        return this.resources().map(resource => path.join(projectConfigDir(resource.root), 'tmp'));
    }

    allowedScratchRoots() {
        return uniqueValues([
            ...this.scratchRoots,
            ...this.projectScratchRoots(),
        ]).map(canonicalRoot);
    }

    isAllowedScratchPath(filePath) {
        const normalized = normalizePathInput(filePath);
        const candidate = canonicalizeCandidate(path.resolve(normalized));
        return this.allowedScratchRoots().some(root => isWithin(root, candidate));
    }

    async registerFileRead(candidate) {
        if (!candidate || !fs.existsSync(candidate)) return null;
        let stat;
        try {
            stat = fs.statSync(candidate);
        } catch {
            return null;
        }
        if (!stat.isFile()) return null;

        const filePath = fs.realpathSync(candidate);
        const dir = path.dirname(filePath);
        if (dir === path.parse(dir).root || dir === os.homedir()) return null;

        const registered = await this.register(dir, { bypassProjectMarkers: true });
        const owner = this.projects.get(registered.resource.project_id);
        if (!owner) return null;

        const files = Array.isArray(owner.resource.files_read)
            ? owner.resource.files_read
            : [];
        if (!files.includes(filePath)) {
            owner.resource.files_read = [...files, filePath];
        }
        return { filePath, project: owner, registered };
    }

    async resolvePath(rawPath, projectIdValue, { allowMissing = false, allowExternalFileRead = false } = {}) {
        let root = null;
        if (projectIdValue) {
            root = this.get(projectIdValue)?.resource.root || null;
            if (!root) throw new Error(`Unknown project_id: ${projectIdValue}`);
        }

        if (!rawPath) {
            if (root) return root;
            if (this.projects.size === 1) return this.resources()[0].root;
            // Fall back to the first registered project when the model omits
            // both path and project_id. Beats throwing on an inferable case.
            const first = this.resources()[0];
            if (first) return first.root;
            throw new Error('No projects registered. Call get_project_overview first.');
        }

        // LLM frequently passes shell-quoted paths copied from a terminal,
        // e.g. "Bahulam/src/app/\(kepler\)/page.tsx". Normalize here so
        // every tool benefits, not just get_project_overview.
        rawPath = normalizePathInput(rawPath);

        const buildCandidate = (input) => {
            if (path.isAbsolute(input)) {
                return canonicalizeCandidate(path.resolve(input));
            }
            if (!root) {
                if (this.projects.size === 1) {
                    return canonicalizeCandidate(path.resolve(this.resources()[0].root, input));
                }
                if (this.projects.size > 1) {
                    throw new Error('Relative path requires project_id when multiple projects are registered. Pass project_id or use an absolute path.');
                }
                throw new Error('No projects registered. Call get_project_overview first.');
            }
            return canonicalizeCandidate(path.resolve(root, input));
        };

        let candidate = buildCandidate(rawPath);

        const findContaining = (cand) => [...this.projects.values()].find(({ resource }) =>
            isWithin(resource.root, cand)
        );
        const findScratchRoot = (cand) => this.allowedScratchRoots().find(scratchRoot =>
            isWithin(scratchRoot, cand)
        );

        let containingProject = findContaining(candidate);
        let containingScratchRoot = containingProject ? null : findScratchRoot(candidate);

        // Two reasons to try the unescaped variant:
        //   (1) candidate is outside every project root (literal "Bahulam"
        //       does not contain a real project), or
        //   (2) candidate is inside a root but does not exist on disk because
        //       a path segment like "\(kepler\)" only resolves once unescaped.
        // We retry once on the unescaped form before raising.
        const needsRetry = !containingProject ||
                           (!allowMissing && !fs.existsSync(candidate));
        if (needsRetry) {
            const unescaped = unescapeShellPath(rawPath);
            if (unescaped !== rawPath) {
                try {
                    const altCandidate = buildCandidate(unescaped);
                    const altProject = findContaining(altCandidate);
                    if (altProject && (allowMissing || fs.existsSync(altCandidate))) {
                        candidate = altCandidate;
                        containingProject = altProject;
                        containingScratchRoot = null;
                    } else {
                        const altScratchRoot = findScratchRoot(altCandidate);
                        if (altScratchRoot && (allowMissing || fs.existsSync(altCandidate))) {
                            candidate = altCandidate;
                            containingScratchRoot = altScratchRoot;
                        }
                    }
                } catch { /* fall through to the original error */ }
            }
        }

        if (!containingProject && !containingScratchRoot) {
            if (allowExternalFileRead) {
                let external = await this.registerFileRead(candidate);
                if (!external) {
                    const unescaped = unescapeShellPath(rawPath);
                    if (unescaped !== rawPath) {
                        try {
                            external = await this.registerFileRead(buildCandidate(unescaped));
                        } catch { /* keep original outside-root error */ }
                    }
                }
                if (external) return external.filePath;
            }
            throw new Error(`Path is outside registered project roots: ${rawPath}`);
        }
        if (!allowMissing && !fs.existsSync(candidate)) {
            throw new Error(`Path not found: ${rawPath}`);
        }
        return candidate;
    }

    projectForPath(filePath) {
        const normalized = normalizePathInput(filePath);
        const candidate = canonicalizeCandidate(path.resolve(normalized));
        const direct = [...this.projects.values()].find(({ resource }) =>
            isWithin(resource.root, candidate)
        );
        if (direct) return direct;
        // Same unescape fallback used in resolvePath.
        const unescaped = unescapeShellPath(normalized);
        if (unescaped !== normalized) {
            const altCandidate = canonicalizeCandidate(path.resolve(unescaped));
            return [...this.projects.values()].find(({ resource }) =>
                isWithin(resource.root, altCandidate)
            ) || null;
        }
        return null;
    }

    reset() {
        this.projects.clear();
    }
}
