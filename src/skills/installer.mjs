/**
 * Portable skill installation and lock metadata.
 *
 * Bundles are copied as data. No scripts or hooks from a skill are executed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverSkillDirectories, parseSkill } from './loader.mjs';

function isGitSource(source) {
    return /^(https?:\/\/|ssh:\/\/|git@|github:)/.test(source) || source.endsWith('.git');
}

function normalizeGitSource(source) {
    if (source.startsWith('github:')) {
        return `https://github.com/${source.slice('github:'.length).replace(/\.git$/, '')}.git`;
    }
    return source;
}

function discoverInstallableSkills(root, maxDepth = 4) {
    const direct = discoverSkillDirectories(root);
    if (direct.length) return direct;

    const found = [];
    const queue = [{ dir: root, depth: 0 }];
    const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build']);
    while (queue.length) {
        const { dir, depth } = queue.shift();
        if (depth >= maxDepth) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(entry.name)) continue;
            const child = path.join(dir, entry.name);
            if (fs.existsSync(path.join(child, 'SKILL.md'))) {
                found.push(child);
            } else {
                queue.push({ dir: child, depth: depth + 1 });
            }
        }
    }
    return found.sort();
}

function rejectSymlinks(root) {
    const queue = [root];
    while (queue.length) {
        const current = queue.shift();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`Symlinked skill resource is not allowed: ${fullPath}`);
            if (entry.isDirectory()) queue.push(fullPath);
        }
    }
}

function copyDirectory(source, destination) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isDirectory()) copyDirectory(from, to);
        else if (entry.isFile()) fs.copyFileSync(from, to);
    }
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

export class SkillInstaller {
    constructor({ cwd = process.cwd(), homeDir = os.homedir() } = {}) {
        this.cwd = path.resolve(cwd);
        this.homeDir = homeDir;
    }

    paths(scope = 'global') {
        const base = scope === 'project'
            ? path.join(this.cwd, '.kepler')
            : path.join(this.homeDir, '.kepler');
        return {
            skillsDir: path.join(base, 'skills'),
            lockFile: path.join(base, 'skills.lock.json'),
        };
    }

    install(source, { scope = 'global', force = false, onlyNames = null } = {}) {
        if (!source) throw new Error('A local directory or Git repository is required');
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-skill-'));
        let resolvedSource;
        let commit = null;
        try {
            if (isGitSource(source)) {
                resolvedSource = path.join(tempRoot, 'repository');
                execFileSync(
                    'git',
                    ['clone', '--depth', '1', normalizeGitSource(source), resolvedSource],
                    { stdio: 'pipe' },
                );
                commit = execFileSync('git', ['-C', resolvedSource, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
            } else {
                resolvedSource = fs.realpathSync(path.resolve(this.cwd, source));
            }

            const skillDirs = discoverInstallableSkills(resolvedSource);
            if (!skillDirs.length) throw new Error(`No SKILL.md bundles found in ${source}`);

            const { skillsDir, lockFile } = this.paths(scope);
            const lock = readJson(lockFile, { version: 1, skills: {} });
            const installed = [];
            fs.mkdirSync(skillsDir, { recursive: true });

            const plans = [];
            for (const skillDir of skillDirs) {
                rejectSymlinks(skillDir);
                const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
                const name = parseSkill(content, path.basename(skillDir)).name;
                if (onlyNames && !onlyNames.includes(name)) continue;
                if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Unsafe skill name: ${name}`);
                const destination = path.join(skillsDir, name);
                if (fs.existsSync(destination)) {
                    if (!force) throw new Error(`Skill already installed: ${name} (use --force to replace)`);
                }
                plans.push({ skillDir, content, name, destination });
            }
            if (!plans.length) {
                throw new Error(
                    onlyNames
                        ? `Requested skill not found in source: ${onlyNames.join(', ')}`
                        : `No installable skills found in ${source}`,
                );
            }

            for (const { skillDir, content, name, destination } of plans) {
                if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
                copyDirectory(skillDir, destination);

                const digest = crypto.createHash('sha256')
                    .update(content)
                    .digest('hex');
                lock.skills[name] = {
                    source,
                    scope,
                    commit,
                    destination,
                    installed_at: new Date().toISOString(),
                    manifest_hash: `sha256:${digest}`,
                };
                installed.push(name);
            }
            writeJson(lockFile, lock);
            return { installed, scope, lock_file: lockFile };
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    }

    remove(name, { scope = 'global' } = {}) {
        const { skillsDir, lockFile } = this.paths(scope);
        const destination = path.join(skillsDir, name);
        if (!fs.existsSync(destination)) throw new Error(`Skill is not installed: ${name}`);
        fs.rmSync(destination, { recursive: true, force: true });
        const lock = readJson(lockFile, { version: 1, skills: {} });
        delete lock.skills[name];
        writeJson(lockFile, lock);
        return { removed: name, scope };
    }

    update(name, { scope = 'global' } = {}) {
        const { lockFile } = this.paths(scope);
        const lock = readJson(lockFile, { version: 1, skills: {} });
        const entry = lock.skills[name];
        if (!entry?.source) throw new Error(`No locked source for skill: ${name}`);
        return this.install(entry.source, { scope, force: true, onlyNames: [name] });
    }

    lock(scope = 'global') {
        return readJson(this.paths(scope).lockFile, { version: 1, skills: {} });
    }
}
