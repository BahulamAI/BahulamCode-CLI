/**
 * Shared lint command resolver.
 *
 * Explicit linting may run a project's declared lint script. Automatic
 * post-edit linting must stay generated and bounded, so it does not run
 * arbitrary package scripts without a visible tool call.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const PYTHON_EXTS = new Set(['.py']);
const JAVASCRIPT_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const TYPESCRIPT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const MDX_EXTS = new Set(['.mdx']);
const GO_EXTS = new Set(['.go']);
const RUST_EXTS = new Set(['.rs']);

const IGNORED_DIRS = new Set([
    '.git', 'node_modules', '.next', '.turbo', 'dist', 'build', 'coverage',
    '.venv', 'venv', '__pycache__', 'target',
]);

const ESLINT_CONFIGS = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yaml',
    '.eslintrc.yml',
];

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];
const RUFF_CONFIGS = ['ruff.toml', '.ruff.toml'];

export function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function resolveLintCommand(targetPath, {
    projectRoot = null,
    projectCommands = {},
    allowProjectScript = true,
} = {}) {
    const target = path.resolve(targetPath || '.');
    const stat = safeStat(target);
    const isDirectory = Boolean(stat?.isDirectory());
    const baseDir = isDirectory ? target : path.dirname(target);
    const root = path.resolve(projectRoot || inferProjectRoot(baseDir) || baseDir);
    const language = detectTargetLanguage(target, { stat, root });

    if (allowProjectScript && isPackageLintEligible(language)) {
        const script = resolvePackageLintScript(baseDir, root, projectCommands);
        if (script) {
            return {
                ...script,
                language,
                target,
                scope: 'project',
            };
        }
    }

    if (language === 'python') {
        return resolvePythonLint(target, { stat, root });
    }
    if (language === 'typescript') {
        return resolveJavaScriptLint(target, { stat, root, typescript: true });
    }
    if (language === 'javascript') {
        return resolveJavaScriptLint(target, { stat, root, typescript: false });
    }
    if (language === 'mdx') {
        return resolveMdxLint(target, { stat, root });
    }
    if (language === 'go') {
        return resolveGoLint(target, { stat, root });
    }
    if (language === 'rust') {
        return resolveRustLint(target, { stat, root });
    }

    return null;
}

function safeStat(filePath) {
    try {
        return fs.statSync(filePath);
    } catch {
        return null;
    }
}

function inferProjectRoot(startDir) {
    return findUp(startDir, path.parse(startDir).root, (dir) => (
        fs.existsSync(path.join(dir, 'package.json')) ||
        fs.existsSync(path.join(dir, 'pyproject.toml')) ||
        fs.existsSync(path.join(dir, 'setup.py')) ||
        fs.existsSync(path.join(dir, 'go.mod')) ||
        fs.existsSync(path.join(dir, 'Cargo.toml')) ||
        fs.existsSync(path.join(dir, '.git'))
    ));
}

function isWithin(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function findUp(startDir, stopDir, predicate) {
    let dir = path.resolve(startDir || '.');
    const stop = path.resolve(stopDir || path.parse(dir).root);
    while (isWithin(stop, dir)) {
        if (predicate(dir)) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function findUpFile(startDir, stopDir, names) {
    const dir = findUp(startDir, stopDir, (candidate) =>
        names.some(name => fs.existsSync(path.join(candidate, name)))
    );
    if (!dir) return null;
    return names.map(name => path.join(dir, name)).find(filePath => fs.existsSync(filePath)) || null;
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

function readPackageJson(dir) {
    return readJson(path.join(dir, 'package.json'));
}

function packageDirs(baseDir, root) {
    const dirs = [];
    const nearest = findUp(baseDir, root, dir => fs.existsSync(path.join(dir, 'package.json')));
    if (nearest) dirs.push(nearest);
    if (fs.existsSync(path.join(root, 'package.json'))) dirs.push(root);
    return [...new Set(dirs.map(dir => path.resolve(dir)))];
}

function packageDeclares(pkg, names) {
    if (!pkg) return false;
    const buckets = [
        pkg.dependencies,
        pkg.devDependencies,
        pkg.peerDependencies,
        pkg.optionalDependencies,
    ];
    return buckets.some(bucket => names.some(name => bucket?.[name]));
}

function hasNodeTool(baseDir, root, bin, packages) {
    return packageDirs(baseDir, root).some((dir) => {
        const pkg = readPackageJson(dir);
        return fs.existsSync(path.join(dir, 'node_modules', '.bin', bin)) ||
            packageDeclares(pkg, packages);
    });
}

function hasConfig(baseDir, root, names) {
    return Boolean(findUpFile(baseDir, root, names));
}

function resolvePackageLintScript(baseDir, root, projectCommands = {}) {
    for (const dir of packageDirs(baseDir, root)) {
        const pkg = readPackageJson(dir);
        if (pkg?.scripts?.lint) {
            return {
                command: 'npm run lint',
                cwd: dir,
                source: 'package-script',
                reason: `package.json lint script in ${path.relative(root, dir) || '.'}`,
            };
        }
    }
    if (projectCommands?.lint) {
        return {
            command: projectCommands.lint,
            cwd: root,
            source: 'project-command',
            reason: 'registered project lint command',
        };
    }
    return null;
}

function isPackageLintEligible(language) {
    return language === 'javascript' || language === 'typescript' ||
        language === 'mdx' || language === 'mixed-js' || language === 'unknown';
}

function detectTargetLanguage(target, { stat, root }) {
    if (stat?.isDirectory()) {
        return detectDirectoryLanguage(target, root);
    }
    const ext = path.extname(target).toLowerCase();
    if (PYTHON_EXTS.has(ext)) return 'python';
    if (TYPESCRIPT_EXTS.has(ext)) return 'typescript';
    if (JAVASCRIPT_EXTS.has(ext)) return 'javascript';
    if (MDX_EXTS.has(ext)) return 'mdx';
    if (GO_EXTS.has(ext)) return 'go';
    if (RUST_EXTS.has(ext)) return 'rust';
    return 'unknown';
}

function detectDirectoryLanguage(dir, root) {
    if (hasConfig(dir, root, ['tsconfig.json'])) return 'typescript';
    if (fs.existsSync(path.join(dir, 'package.json')) || hasConfig(dir, root, ESLINT_CONFIGS) || hasConfig(dir, root, BIOME_CONFIGS)) {
        return 'javascript';
    }
    if (
        fs.existsSync(path.join(dir, 'pyproject.toml')) ||
        fs.existsSync(path.join(dir, 'setup.py')) ||
        fs.existsSync(path.join(dir, 'requirements.txt'))
    ) {
        return 'python';
    }
    if (hasConfig(dir, root, ['go.mod'])) return 'go';
    if (hasConfig(dir, root, ['Cargo.toml'])) return 'rust';

    const counts = { python: 0, typescript: 0, javascript: 0, mdx: 0, go: 0, rust: 0 };
    scanDirectory(dir, (filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        if (PYTHON_EXTS.has(ext)) counts.python++;
        else if (TYPESCRIPT_EXTS.has(ext)) counts.typescript++;
        else if (JAVASCRIPT_EXTS.has(ext)) counts.javascript++;
        else if (MDX_EXTS.has(ext)) counts.mdx++;
        else if (GO_EXTS.has(ext)) counts.go++;
        else if (RUST_EXTS.has(ext)) counts.rust++;
    });
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return ranked[0]?.[1] > 0 ? ranked[0][0] : 'unknown';
}

function scanDirectory(root, visit) {
    const queue = [root];
    let scanned = 0;
    while (queue.length > 0 && scanned < 300) {
        const dir = queue.shift();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                queue.push(fullPath);
            } else if (entry.isFile()) {
                scanned++;
                visit(fullPath);
            }
            if (scanned >= 300) break;
        }
    }
}

function shellPathArg(target, cwd) {
    const rel = path.relative(cwd, target);
    const value = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : target;
    return shellQuote(value || '.');
}

function captured(command) {
    return `${command} 2>&1 || true`;
}

function resolveJavaScriptLint(target, { stat, root, typescript }) {
    const baseDir = stat?.isDirectory() ? target : path.dirname(target);
    const eslintReady = hasConfig(baseDir, root, ESLINT_CONFIGS) ||
        hasNodeTool(baseDir, root, 'eslint', ['eslint']);
    if (eslintReady) {
        const cwd = packageDirs(baseDir, root)[0] || root;
        return {
            command: captured(`npx --no-install eslint ${shellPathArg(target, cwd)}`),
            cwd,
            language: typescript ? 'typescript' : 'javascript',
            target,
            scope: 'file',
            source: 'eslint',
            reason: 'eslint project config or dependency',
        };
    }

    const biomeReady = hasConfig(baseDir, root, BIOME_CONFIGS) ||
        hasNodeTool(baseDir, root, 'biome', ['@biomejs/biome', 'biome']);
    if (biomeReady) {
        const cwd = packageDirs(baseDir, root)[0] || root;
        return {
            command: captured(`npx --no-install biome check ${shellPathArg(target, cwd)}`),
            cwd,
            language: typescript ? 'typescript' : 'javascript',
            target,
            scope: 'file',
            source: 'biome',
            reason: 'biome project config or dependency',
        };
    }

    if (typescript) {
        const tsconfig = findUpFile(baseDir, root, ['tsconfig.json']);
        if (!tsconfig) return null;
        const cwd = path.dirname(tsconfig);
        const hasTypescript = hasNodeTool(baseDir, root, 'tsc', ['typescript']);
        if (!hasTypescript) return null;
        return {
            command: captured(`npx --no-install tsc --noEmit --pretty false -p ${shellPathArg(tsconfig, cwd)}`),
            cwd,
            language: 'typescript',
            target,
            scope: 'project',
            source: 'typescript',
            reason: 'tsconfig project check',
        };
    }

    const ext = path.extname(target).toLowerCase();
    if (!stat?.isDirectory() && ['.js', '.mjs', '.cjs'].includes(ext)) {
        return {
            command: captured(`node --check ${shellPathArg(target, root)}`),
            cwd: root,
            language: 'javascript',
            target,
            scope: 'file',
            source: 'node-check',
            reason: 'javascript syntax check fallback',
        };
    }

    return null;
}

function resolveMdxLint(target, { stat, root }) {
    const baseDir = stat?.isDirectory() ? target : path.dirname(target);
    const eslintReady = hasConfig(baseDir, root, ESLINT_CONFIGS) ||
        hasNodeTool(baseDir, root, 'eslint', ['eslint', 'eslint-plugin-mdx', 'eslint-mdx', '@mdx-js/eslint-mdx']);
    if (eslintReady) {
        const cwd = packageDirs(baseDir, root)[0] || root;
        return {
            command: captured(`npx --no-install eslint ${shellPathArg(target, cwd)}`),
            cwd,
            language: 'mdx',
            target,
            scope: stat?.isDirectory() ? 'project' : 'file',
            source: 'eslint',
            reason: 'eslint/MDX project config or dependency',
        };
    }

    const biomeReady = hasConfig(baseDir, root, BIOME_CONFIGS) ||
        hasNodeTool(baseDir, root, 'biome', ['@biomejs/biome', 'biome']);
    if (biomeReady) {
        const cwd = packageDirs(baseDir, root)[0] || root;
        return {
            command: captured(`npx --no-install biome check ${shellPathArg(target, cwd)}`),
            cwd,
            language: 'mdx',
            target,
            scope: stat?.isDirectory() ? 'project' : 'file',
            source: 'biome',
            reason: 'biome project config or dependency',
        };
    }

    return null;
}

function resolvePythonLint(target, { stat, root }) {
    const baseDir = stat?.isDirectory() ? target : path.dirname(target);
    const pyproject = findUpFile(baseDir, root, ['pyproject.toml']);
    const hasRuffConfig = hasConfig(baseDir, root, RUFF_CONFIGS) ||
        (pyproject && /\[tool\.ruff\b|ruff\b/i.test(readText(pyproject, 12000))) ||
        fileMentions(baseDir, root, ['requirements.txt', 'requirements-dev.txt'], /^ruff(?:[<=>~\s]|$)/im);

    if (hasRuffConfig) {
        return {
            command: captured(`python3 -m ruff check ${shellPathArg(target, root)}`),
            cwd: root,
            language: 'python',
            target,
            scope: stat?.isDirectory() ? 'project' : 'file',
            source: 'ruff',
            reason: 'ruff project config or dependency',
        };
    }

    if (!stat?.isDirectory()) {
        return {
            command: captured(`python3 -m py_compile ${shellPathArg(target, root)}`),
            cwd: root,
            language: 'python',
            target,
            scope: 'file',
            source: 'py-compile',
            reason: 'python syntax check fallback',
        };
    }

    return null;
}

function readText(filePath, maxChars = 8000) {
    try {
        return fs.readFileSync(filePath, 'utf-8').slice(0, maxChars);
    } catch {
        return '';
    }
}

function fileMentions(baseDir, root, names, re) {
    const filePath = findUpFile(baseDir, root, names);
    return filePath ? re.test(readText(filePath, 12000)) : false;
}

function resolveGoLint(target, { stat, root }) {
    const baseDir = stat?.isDirectory() ? target : path.dirname(target);
    const goMod = findUpFile(baseDir, root, ['go.mod']);
    const cwd = goMod ? path.dirname(goMod) : root;
    const arg = stat?.isDirectory() && goMod ? './...' : shellPathArg(target, cwd);
    return {
        command: captured(`go vet ${arg}`),
        cwd,
        language: 'go',
        target,
        scope: stat?.isDirectory() ? 'project' : 'file',
        source: 'go-vet',
        reason: 'go vet',
    };
}

function resolveRustLint(target, { stat, root }) {
    const baseDir = stat?.isDirectory() ? target : path.dirname(target);
    const cargoToml = findUpFile(baseDir, root, ['Cargo.toml']);
    if (cargoToml && stat?.isDirectory()) {
        const cwd = path.dirname(cargoToml);
        return {
            command: captured('cargo clippy --quiet'),
            cwd,
            language: 'rust',
            target,
            scope: 'project',
            source: 'cargo-clippy',
            reason: 'cargo clippy',
        };
    }
    if (!stat?.isDirectory()) {
        return {
            command: captured(`rustfmt --check ${shellPathArg(target, root)}`),
            cwd: root,
            language: 'rust',
            target,
            scope: 'file',
            source: 'rustfmt',
            reason: 'rustfmt check',
        };
    }
    return null;
}
