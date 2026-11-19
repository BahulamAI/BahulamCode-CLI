/**
 * Portable Agent Skills loader.
 *
 * Discovers standard <root>/<skill>/SKILL.md bundles from .agents, Bahulam and Claude
 * locations. Only metadata is exposed eagerly; instructions and resources are
 * loaded on demand through view().
 */

import crypto from 'node:crypto';
import { load as parseYaml } from 'js-yaml';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_CHARS = 12_000;

function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function parseSkill(content, fallbackName) {
    const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
    if (!match) throw new Error('SKILL.md requires YAML frontmatter');

    const metadata = parseYaml(match[1]);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('SKILL.md requires a metadata mapping');
    }
    const name = String(metadata.name || fallbackName || '').trim();
    const description = String(metadata.description || '').trim();
    const instructions = content.slice(match[0].length).trim();
    if (!name) throw new Error("SKILL.md requires non-empty 'name'");
    if (!description) throw new Error("SKILL.md requires non-empty 'description'");
    if (!instructions) throw new Error('SKILL.md requires instruction content');

    return {
        name,
        description,
        aliases: Array.isArray(metadata.aliases) ? metadata.aliases : [],
        compatibility: metadata.compatibility || [],
        metadata,
        instructions,
        prompt: instructions,
    };
}

export function discoverSkillDirectories(root) {
    if (!root || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
    const resolved = fs.realpathSync(root);
    if (fs.existsSync(path.join(resolved, 'SKILL.md'))) return [resolved];
    return fs.readdirSync(resolved, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => path.join(resolved, entry.name))
        .filter(dir => fs.existsSync(path.join(dir, 'SKILL.md')))
        .sort();
}

function walkFiles(root) {
    const files = [];
    const queue = [root];
    while (queue.length) {
        const current = queue.shift();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) queue.push(fullPath);
            else if (entry.isFile()) files.push(fullPath);
        }
    }
    return files.sort((a, b) => a.localeCompare(b));
}

function contentHash(root) {
    const digest = crypto.createHash('sha256');
    for (const filePath of walkFiles(root)) {
        digest.update(path.relative(root, filePath).split(path.sep).join('/'));
        digest.update('\0');
        digest.update(fs.readFileSync(filePath));
        digest.update('\0');
    }
    return `sha256:${digest.digest('hex')}`;
}

function bounded(content, maxChars) {
    if (content.length <= maxChars) return content;
    const head = Math.floor(maxChars * 0.7);
    const tail = maxChars - head;
    return `${content.slice(0, head)}\n\n[... skill content truncated ...]\n\n${content.slice(-tail)}`;
}

export class SkillsLoader {
    constructor({ homeDir = os.homedir() } = {}) {
        this.homeDir = homeDir;
        this.bahulamDir = homeDir === os.homedir() && process.env.BAHULAM_HOME
            ? process.env.BAHULAM_HOME : path.join(homeDir, '.bahulam');
        this.skills = new Map();
        this.versions = new Map();
        this.searchPaths = [];
    }

    load(cwd = process.cwd()) {
        this.skills.clear();
        this.versions.clear();
        const project = path.resolve(cwd);
        const roots = [project];
        // Discover repository bundles when the CLI starts inside a package.
        for (let dir = project; ; dir = path.dirname(dir)) {
            if (fs.existsSync(path.join(dir, '.git'))) {
                while (roots.at(-1) !== dir) roots.push(path.dirname(roots.at(-1)));
                break;
            }
            if (dir === path.dirname(dir)) break;
        }
        this.searchPaths = roots.flatMap((root, i) => [
            { dir: path.join(root, '.bahulam', 'skills'), source: 'bahulam-project', scope: 'project', ancestor: i > 0, priority: 600 + (roots.length - i) * 3 },
            { dir: path.join(root, '.agents', 'skills'), source: 'agents-project', scope: 'project', ancestor: i > 0, priority: 599 + (roots.length - i) * 3 },
            { dir: path.join(root, '.claude', 'skills'), source: 'claude-project', scope: 'project', ancestor: i > 0, priority: 598 + (roots.length - i) * 3 },
        ]);
        this.searchPaths.push(
            { dir: path.join(this.bahulamDir, 'skills'), source: 'bahulam-global', scope: 'global', priority: 300 },
            { dir: path.join(this.homeDir, '.agents', 'skills'), source: 'agents-global', scope: 'global', priority: 250 },
            { dir: path.join(this.homeDir, '.claude', 'skills'), source: 'claude-global', scope: 'global', priority: 200 },
        );

        for (const config of this.searchPaths) this._loadFromDir(config);
        return this;
    }

    /** Add skills shipped by already-validated plugins without clearing the
     * normal project/global sources. Project skills retain higher precedence;
     * plugin skills intentionally outrank unrelated global skills. */
    loadPluginSkills(pluginRegistry) {
        if (!pluginRegistry?.listSkillSources) return this;
        for (const entry of pluginRegistry.listSkillSources()) {
            const source = `plugin:${entry.plugin}:${entry.id}`;
            const config = { dir: entry.root, source, scope: 'plugin', priority: 350 };
            this.searchPaths.push(config);
            this._loadFromDir(config);
        }
        return this;
    }

    _loadFromDir(config) {
        for (const skillDir of discoverSkillDirectories(config.dir)) {
            try {
                const skillFile = path.join(skillDir, 'SKILL.md');
                if (fs.lstatSync(skillFile).isSymbolicLink()) continue;
                const parsed = parseSkill(fs.readFileSync(skillFile, 'utf-8'), path.basename(skillDir));
                const skill = {
                    ...parsed,
                    root: skillDir,
                    source: config.source,
                    source_id: `${config.source}:${parsed.name}${config.ancestor ? '@' + config.dir : ''}`,
                    scope: config.scope,
                    priority: config.priority,
                    content_hash: contentHash(skillDir),
                };
                const versions = this.versions.get(skill.name) || [];
                versions.push(skill);
                versions.sort((a, b) => b.priority - a.priority || a.source.localeCompare(b.source));
                this.versions.set(skill.name, versions);
                this.skills.set(skill.name, versions[0]);
            } catch {
                // Invalid third-party bundles are ignored during discovery.
            }
        }
    }

    get(name, sourceId = null) {
        if (sourceId) {
            return (this.versions.get(name) || []).find(skill => skill.source_id === sourceId) || null;
        }
        if (this.skills.has(name)) return this.skills.get(name);
        for (const skill of this.skills.values()) {
            if (skill.name.startsWith(name) || skill.aliases.includes(name)) return skill;
        }
        return null;
    }

    list({ query = '', source = '', scope = '' } = {}) {
        const needle = query.toLowerCase();
        return [...this.skills.values()]
            .filter(skill => !source || skill.source === source)
            .filter(skill => !scope || skill.scope === scope)
            .filter(skill => !needle || `${skill.name} ${skill.description}`.toLowerCase().includes(needle))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(skill => ({
                name: skill.name,
                description: skill.description,
                source: skill.source,
                source_id: skill.source_id,
                scope: skill.scope,
                path: path.join(skill.root, 'SKILL.md'),
                content_hash: skill.content_hash,
                compatibility: skill.compatibility,
                shadowed_sources: (this.versions.get(skill.name) || []).slice(1).map(item => item.source_id),
            }));
    }

    view(name, resourcePath = null, { sourceId = null, maxChars = DEFAULT_MAX_CHARS } = {}) {
        const skill = this.get(name, sourceId);
        if (!skill) throw new Error(`Unknown skill: ${name}`);
        if (!resourcePath) {
            return {
                name: skill.name,
                description: skill.description,
                source: skill.source,
                source_id: skill.source_id,
                scope: skill.scope,
                content_hash: skill.content_hash,
                compatibility: skill.compatibility,
                shadowed_sources: (this.versions.get(skill.name) || [])
                    .filter(item => item.source_id !== skill.source_id)
                    .map(item => item.source_id),
                instructions: bounded(skill.instructions, maxChars),
                resources: walkFiles(skill.root)
                    .map(file => path.relative(skill.root, file).split(path.sep).join('/'))
                    .filter(file => file !== 'SKILL.md'),
                metadata: skill.metadata,
            };
        }

        if (path.isAbsolute(resourcePath)) throw new Error('Skill resource path must be relative');
        const candidate = path.resolve(skill.root, resourcePath);
        if (!isWithin(skill.root, candidate)) throw new Error('Skill resource escapes its bundle');
        const relativeParts = path.relative(skill.root, candidate).split(path.sep);
        let cursor = skill.root;
        for (const part of relativeParts) {
            cursor = path.join(cursor, part);
            if (!fs.existsSync(cursor)) throw new Error(`Skill resource not found: ${resourcePath}`);
            if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Symlinked skill resources are not allowed');
        }
        if (!fs.statSync(candidate).isFile()) throw new Error(`Skill resource not found: ${resourcePath}`);
        return {
            name: skill.name,
            source_id: skill.source_id,
            path: resourcePath,
            content: bounded(fs.readFileSync(candidate, 'utf-8'), maxChars),
        };
    }

    async run(name, args) {
        const skill = this.get(name);
        if (!skill) throw new Error(`Unknown skill: ${name}`);
        let prompt = skill.instructions;
        if (args) prompt = prompt.replace(/\$ARGUMENTS/g, args);
        return `[Skill: ${skill.name}]\n${prompt}${args ? `\n\nArguments: ${args}` : ''}`;
    }
}
