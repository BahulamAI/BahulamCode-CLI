import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ContextRetriever } from '../context/retriever.mjs';
import { buildProjectSkeleton } from '../context/skeleton.mjs';
import { indexDir as getIndexDir } from '../core/paths.mjs';

const RESOURCE_FILE = 'project-resource.json';
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
    '.git', '.kepler', '.next', '.venv', '__pycache__',
    'build', 'dist', 'node_modules', 'venv',
]);

function projectId(canonicalPath) {
    return crypto.createHash('sha256').update(canonicalPath).digest('hex').slice(0, 12);
}

function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
            timeout: 2000,
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
        ['pytest', 'pytest'],
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

function _scanSkills(keplerDir) {
    const skillsDir = path.join(keplerDir, 'skills');
    if (!fs.existsSync(skillsDir)) return [];
    try {
        return fs.readdirSync(skillsDir)
            .filter(f => f.endsWith('.md'))
            .map(f => {
                const content = fs.readFileSync(path.join(skillsDir, f), 'utf-8');
                const descMatch = content.match(/^#\s+.*\n+(.+)/);
                return {
                    name: f.replace('.md', ''),
                    description: descMatch ? descMatch[1].slice(0, 100) : f.replace('.md', ''),
                };
            });
    } catch { return []; }
}

export class ProjectRegistry {
    constructor() {
        this.projects = new Map();
        this._globalIdentity = null;
        this._globalPreferences = null;
        this._globalSkills = null;
    }

    /**
     * Load global context from ~/.kepler/ (once per session).
     */
    loadGlobalContext() {
        if (this._globalIdentity !== null) return;
        const globalDir = path.join(os.homedir(), '.kepler');
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

    async register(rawPath) {
        if (!rawPath) {
            throw new Error('get_project_overview requires a project path');
        }
        if (!path.isAbsolute(rawPath)) {
            rawPath = path.resolve(process.cwd(), rawPath);
        }

        let root;
        try {
            root = fs.realpathSync(rawPath);
        } catch {
            throw new Error(`Project path not found: ${rawPath}`);
        }
        if (!fs.statSync(root).isDirectory()) {
            throw new Error(`Project path is not a directory: ${root}`);
        }
        if (root === path.parse(root).root || root === os.homedir()) {
            throw new Error(
                `Refusing to index ${root} — too broad. Pass the project directory itself.`
            );
        }

        const id = projectId(root);
        const existing = this.projects.get(id);
        if (existing) {
            return {
                already_registered: true,
                resource: existing.resource,
                output:
                    `Project already registered as project_id=${id}. ` +
                    `Use project_id=${id} with search_code and use absolute paths for file tools.`,
            };
        }

        const fingerprint = projectFingerprint(root);
        const retriever = new ContextRetriever(root);
        const resourcePath = path.join(getIndexDir(root), RESOURCE_FILE);
        let resource = null;

        try {
            const persisted = JSON.parse(fs.readFileSync(resourcePath, 'utf-8'));
            if (persisted.index_version === fingerprint && retriever.loadIndex()) {
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

        // Read project-level context files (.kepler/project.md, goal.md, skills/)
        const keplerDir = path.join(root, '.kepler');
        resource.environment = detectEnvironment();
        resource.project_context = _readIfExists(keplerDir, 'project.md', 8000);
        resource.goal = _readIfExists(keplerDir, 'goal.md', 2000);
        resource.plan = _readIfExists(keplerDir, 'plan.md', 6000);
        resource.skills_index = _scanSkills(keplerDir);

        // Also check for top-level context files (AGENTS.md, CLAUDE.md, .kepler.md)
        if (!resource.project_context) {
            for (const name of ['.kepler.md', 'AGENTS.md', 'CLAUDE.md']) {
                const content = _readIfExists(root, name, 8000);
                if (content) { resource.project_context = content; break; }
            }
        }

        this.projects.set(id, { resource, retriever });
        return { already_registered: false, resource, output: formatResource(resource) };
    }

    resources() {
        return [...this.projects.values()].map(({ resource }) => resource);
    }

    get(projectIdValue) {
        return this.projects.get(projectIdValue) || null;
    }

    resolvePath(rawPath, projectIdValue, { allowMissing = false } = {}) {
        let root = null;
        if (projectIdValue) {
            root = this.get(projectIdValue)?.resource.root || null;
            if (!root) throw new Error(`Unknown project_id: ${projectIdValue}`);
        }

        if (!rawPath) {
            if (root) return root;
            if (this.projects.size === 1) return this.resources()[0].root;
            throw new Error('Path requires project_id when multiple or no projects are registered');
        }

        let candidate;
        if (path.isAbsolute(rawPath)) {
            candidate = canonicalizeCandidate(path.resolve(rawPath));
        } else {
            if (!root) {
                if (this.projects.size !== 1) {
                    throw new Error('Relative path requires project_id when multiple or no projects are registered');
                }
                root = this.resources()[0].root;
            }
            candidate = canonicalizeCandidate(path.resolve(root, rawPath));
        }

        const containingProject = [...this.projects.values()].find(({ resource }) =>
            isWithin(resource.root, candidate)
        );
        if (!containingProject) {
            throw new Error(`Path is outside registered project roots: ${rawPath}`);
        }
        if (!allowMissing && !fs.existsSync(candidate)) {
            throw new Error(`Path not found: ${rawPath}`);
        }
        return candidate;
    }

    projectForPath(filePath) {
        const candidate = canonicalizeCandidate(path.resolve(filePath));
        return [...this.projects.values()].find(({ resource }) =>
            isWithin(resource.root, candidate)
        ) || null;
    }

    reset() {
        this.projects.clear();
    }
}
