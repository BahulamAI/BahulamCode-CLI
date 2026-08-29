/**
 * Tests for shared project-aware lint command resolution.
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLintCommand } from '../src/core/lint-resolver.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (err) {
        console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
        failed++;
    }
}

function tempProject(name) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `bahulam-${name}-`));
}

function write(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

console.log('\n\x1b[1mtest-lint-resolver.mjs\x1b[0m\n');

test('explicit JavaScript lint prefers package lint script', () => {
    const root = tempProject('lint-script');
    try {
        write(path.join(root, 'package.json'), JSON.stringify({
            scripts: { lint: 'eslint .' },
            devDependencies: { eslint: '^9.0.0' },
        }));
        write(path.join(root, 'src', 'app.js'), 'console.log("ok");\n');

        const lint = resolveLintCommand(path.join(root, 'src', 'app.js'), {
            projectRoot: root,
            projectCommands: { lint: 'npm run lint' },
            allowProjectScript: true,
        });

        assert.equal(lint.command, 'npm run lint');
        assert.equal(lint.cwd, root);
        assert.equal(lint.source, 'package-script');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('automatic JavaScript lint skips package scripts and uses generated file checks', () => {
    const root = tempProject('lint-auto');
    try {
        write(path.join(root, 'package.json'), JSON.stringify({
            scripts: { lint: 'node arbitrary-project-script.js' },
            devDependencies: { eslint: '^9.0.0' },
        }));
        write(path.join(root, 'eslint.config.mjs'), 'export default [];\n');
        write(path.join(root, 'src', 'app.js'), 'console.log("ok");\n');

        const lint = resolveLintCommand(path.join(root, 'src', 'app.js'), {
            projectRoot: root,
            projectCommands: { lint: 'npm run lint' },
            allowProjectScript: false,
        });

        assert.match(lint.command, /npx --no-install eslint/);
        assert.ok(!lint.command.includes('npm run lint'));
        assert.equal(lint.source, 'eslint');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('explicit MDX lint prefers package lint script', () => {
    const root = tempProject('lint-mdx-script');
    try {
        write(path.join(root, 'package.json'), JSON.stringify({
            scripts: { lint: 'eslint .' },
            devDependencies: { eslint: '^9.0.0' },
        }));
        write(path.join(root, 'docs', 'page.mdx'), '# Hello\n');

        const lint = resolveLintCommand(path.join(root, 'docs', 'page.mdx'), {
            projectRoot: root,
            projectCommands: { lint: 'npm run lint' },
            allowProjectScript: true,
        });

        assert.equal(lint.command, 'npm run lint');
        assert.equal(lint.cwd, root);
        assert.equal(lint.language, 'mdx');
        assert.equal(lint.source, 'package-script');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('automatic MDX lint skips package scripts and uses ESLint when configured', () => {
    const root = tempProject('lint-mdx-eslint');
    try {
        write(path.join(root, 'package.json'), JSON.stringify({
            scripts: { lint: 'node arbitrary-project-script.js' },
            devDependencies: { eslint: '^9.0.0', 'eslint-plugin-mdx': '^3.0.0' },
        }));
        write(path.join(root, 'eslint.config.mjs'), 'export default [];\n');
        write(path.join(root, 'docs', 'page.mdx'), '# Hello\n');

        const lint = resolveLintCommand(path.join(root, 'docs', 'page.mdx'), {
            projectRoot: root,
            projectCommands: { lint: 'npm run lint' },
            allowProjectScript: false,
        });

        assert.match(lint.command, /npx --no-install eslint/);
        assert.ok(lint.command.includes('docs/page.mdx'), lint.command);
        assert.ok(!lint.command.includes('npm run lint'));
        assert.equal(lint.language, 'mdx');
        assert.equal(lint.source, 'eslint');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('automatic MDX lint uses Biome when ESLint is not configured', () => {
    const root = tempProject('lint-mdx-biome');
    try {
        write(path.join(root, 'package.json'), JSON.stringify({
            devDependencies: { '@biomejs/biome': '^1.9.0' },
        }));
        write(path.join(root, 'biome.json'), '{}\n');
        write(path.join(root, 'docs', 'page.mdx'), '# Hello\n');

        const lint = resolveLintCommand(path.join(root, 'docs', 'page.mdx'), {
            projectRoot: root,
            allowProjectScript: false,
        });

        assert.match(lint.command, /npx --no-install biome check/);
        assert.equal(lint.language, 'mdx');
        assert.equal(lint.source, 'biome');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('MDX without ESLint or Biome does not fall back to tsc or node check', () => {
    const root = tempProject('lint-mdx-no-tool');
    try {
        write(path.join(root, 'package.json'), JSON.stringify({
            devDependencies: { typescript: '^5.0.0' },
        }));
        write(path.join(root, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true },
            include: ['docs/**/*.mdx'],
        }));
        write(path.join(root, 'docs', 'page.mdx'), '# Hello\n');

        const lint = resolveLintCommand(path.join(root, 'docs', 'page.mdx'), {
            projectRoot: root,
            allowProjectScript: false,
        });

        assert.equal(lint, null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('TypeScript lint uses tsconfig project mode, never file mode tsc', () => {
    const root = tempProject('lint-ts');
    try {
        write(path.join(root, 'package.json'), JSON.stringify({
            devDependencies: { typescript: '^5.0.0' },
        }));
        write(path.join(root, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true },
            include: ['src/**/*.ts'],
        }));
        write(path.join(root, 'src', 'app.ts'), 'const value: string = "ok";\n');

        const lint = resolveLintCommand(path.join(root, 'src', 'app.ts'), {
            projectRoot: root,
            allowProjectScript: false,
        });

        assert.match(lint.command, /npx --no-install tsc --noEmit --pretty false -p/);
        assert.ok(!lint.command.includes('src/app.ts'), lint.command);
        assert.equal(lint.source, 'typescript');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('TypeScript without project config does not invent a file-mode tsc command', () => {
    const root = tempProject('lint-ts-no-config');
    try {
        write(path.join(root, 'package.json'), JSON.stringify({
            devDependencies: { typescript: '^5.0.0' },
        }));
        write(path.join(root, 'src', 'app.ts'), 'const value: string = "ok";\n');

        const lint = resolveLintCommand(path.join(root, 'src', 'app.ts'), {
            projectRoot: root,
            allowProjectScript: false,
        });

        assert.equal(lint, null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Python lint falls back to py_compile without Ruff config', () => {
    const root = tempProject('lint-py');
    try {
        write(path.join(root, 'script.py'), 'print("ok")\n');

        const lint = resolveLintCommand(path.join(root, 'script.py'), {
            projectRoot: root,
            allowProjectScript: false,
        });

        assert.match(lint.command, /python3 -m py_compile/);
        assert.equal(lint.source, 'py-compile');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

if (failed > 0) {
    console.log(`\n${failed} test(s) failed`);
    process.exit(1);
}

console.log(`\n${passed} tests passed`);
