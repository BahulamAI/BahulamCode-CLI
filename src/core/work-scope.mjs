import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCHEMA = 'kepler.work_scope/1';
const ROOT_MARKERS = [
    '.bahulam',
    '.git',
    'package.json',
    'pyproject.toml',
    'setup.py',
    'go.mod',
    'Cargo.toml',
];

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, v]) => v !== undefined)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, stable(v)]),
        );
    }
    return value;
}

function sha(payload) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(stable(payload)))
        .digest('hex')
        .slice(0, 16);
}

function normalizePathInput(value) {
    let s = String(value || '').trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1);
    }
    if (s === '~' || s.startsWith('~/')) {
        s = path.join(os.homedir(), s.slice(1));
    }
    return s.replace(/\\([ \t()&$;'"])/g, '$1');
}

function nearestProjectRoot(candidate) {
    let resolved = normalizePathInput(candidate);
    if (!resolved || !path.isAbsolute(resolved)) return null;

    try {
        resolved = fs.realpathSync(resolved);
    } catch {
        return null;
    }

    let dir = resolved;
    try {
        if (fs.statSync(resolved).isFile()) dir = path.dirname(resolved);
    } catch {
        return null;
    }

    const root = path.parse(dir).root;
    let current = dir;
    while (current && current !== root) {
        if (ROOT_MARKERS.some(marker => fs.existsSync(path.join(current, marker)))) {
            return fs.realpathSync(current);
        }
        current = path.dirname(current);
    }
    return fs.realpathSync(dir);
}

function extractQuotedPaths(text) {
    const paths = [];
    const re = /(['"])(\/[^'"\n]+)\1/g;
    let match;
    while ((match = re.exec(String(text || ''))) !== null) {
        paths.push(match[2]);
    }
    return paths;
}

function isInsideQuotedSpan(source, index) {
    let quote = null;
    let escaped = false;
    for (let i = 0; i < index; i++) {
        const ch = source[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if ((ch === '"' || ch === "'")) {
            quote = quote === ch ? null : (quote || ch);
        }
    }
    return Boolean(quote);
}

function extractPastedPaths(text) {
    const source = String(text || '');
    const paths = [];
    for (let i = 0; i < source.length; i++) {
        if (source[i] !== '/') continue;
        if (isInsideQuotedSpan(source, i)) continue;
        const line = source.slice(i).split(/\r?\n/, 1)[0].replace(/[),.;:]+$/g, '');
        const parts = line.split(/\s+/).filter(Boolean);
        let candidate = '';
        let lastRoot = null;
        for (const part of parts.slice(0, 12)) {
            candidate = candidate ? `${candidate} ${part}` : part;
            const root = nearestProjectRoot(candidate.replace(/[),.;:]+$/g, ''));
            if (root) lastRoot = root;
        }
        if (lastRoot) paths.push(lastRoot);
    }
    return paths;
}

function uniqueRoots(entries) {
    const seen = new Set();
    const result = [];
    for (const entry of entries) {
        if (!entry?.path || seen.has(entry.path)) continue;
        seen.add(entry.path);
        result.push(entry);
    }
    return result;
}

export function promptProjectRoots(instruction = '') {
    const roots = [];
    const seen = new Set();
    for (const raw of [...extractQuotedPaths(instruction), ...extractPastedPaths(instruction)]) {
        const root = nearestProjectRoot(raw);
        if (!root || seen.has(root)) continue;
        seen.add(root);
        roots.push(root);
    }
    return roots;
}

function roleForRoot(root, cwd) {
    const base = path.basename(root).toLowerCase();
    if (base.includes('backend')) return 'backend';
    if (base.includes('frontend') || base.includes('web')) return 'frontend';
    if (base.includes('deploy')) return 'deploy';
    if (base.includes('docs') || base.includes('prd')) return 'docs';
    if (base.includes('npm') || base.includes('cli')) return 'cli';
    if (root === cwd) return 'primary';
    return 'workspace';
}

function truncate(value, max = 280) {
    const s = String(value || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sortedResources(resources) {
    return (Array.isArray(resources) ? resources : [])
        .filter(resource => resource && resource.root)
        .map(resource => ({
            project_id: String(resource.project_id || ''),
            root: String(resource.root || ''),
            name: String(resource.name || path.basename(String(resource.root || ''))),
            index_version: String(resource.index_version || ''),
        }))
        .sort((a, b) => a.root.localeCompare(b.root));
}

export function buildWorkScope({
    instruction = '',
    cwd = process.cwd(),
    projectResources = [],
} = {}) {
    const cwdRoot = nearestProjectRoot(cwd) || path.resolve(cwd);
    const roots = [{
        path: cwdRoot,
        role: roleForRoot(cwdRoot, cwdRoot),
        source: 'cwd',
        status: 'active',
    }];

    for (const root of promptProjectRoots(instruction)) {
        roots.push({
            path: root,
            role: roleForRoot(root, cwdRoot),
            source: 'prompt',
            status: 'active',
        });
    }

    for (const resource of sortedResources(projectResources)) {
        roots.push({
            path: resource.root,
            role: roleForRoot(resource.root, cwdRoot),
            source: 'registered',
            status: 'active',
            project_id: resource.project_id || undefined,
        });
    }

    const activeRoots = uniqueRoots(roots);
    const resources = sortedResources(projectResources);
    const scope = {
        schema: SCHEMA,
        primary_root: cwdRoot,
        intent: truncate(instruction),
        active_roots: activeRoots,
        candidate_roots: [],
        workspace_resources: resources,
        cache_policy: {
            stable_system: false,
            placement: 'pinned_context',
            reason: 'scope changes with user intent and discovered roots',
        },
    };
    scope.version = sha({
        schema: scope.schema,
        primary_root: scope.primary_root,
        intent: scope.intent,
        active_roots: scope.active_roots,
        workspace_resources: scope.workspace_resources,
    });
    return scope;
}

export function summarizeWorkScope(scope) {
    if (!scope || typeof scope !== 'object') return '';
    const roots = Array.isArray(scope.active_roots) ? scope.active_roots : [];
    const lines = [
        `Work scope ${scope.version || 'unknown'}`,
        `Primary: ${scope.primary_root || '(unknown)'}`,
    ];
    if (scope.intent) lines.push(`Intent: ${scope.intent}`);
    for (const root of roots) {
        if (!root?.path) continue;
        lines.push(`- ${root.path} [${root.role || 'workspace'}; ${root.source || 'unknown'}]`);
    }
    return lines.join('\n');
}
