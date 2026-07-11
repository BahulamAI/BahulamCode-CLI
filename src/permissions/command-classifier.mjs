/**
 * Command Classifier — port of Claude Code's read-only validation.
 *
 * Classifies shell commands into three categories:
 *   - 'safe'      → read-only, auto-approved, no sandbox
 *   - 'contained' → needs .venv/sandbox (tests, builds, installs)
 *   - 'blocked'   → requires HITL approval (destructive, network-exec)
 *
 * Based on openclaude-reference/src/tools/BashTool/readOnlyValidation.ts
 * Ported: COMMAND_ALLOWLIST, flag validation, expansion detection.
 *
 * NOT ported (too complex, diminishing returns):
 *   - shell-quote parser (we use regex splitting)
 *   - UNC path detection (Windows-specific)
 *   - bare git repo detection
 */

// ═══════════════════════════════════════════════════════════════════
// Section 1: Command Splitting
// ═══════════════════════════════════════════════════════════════════

/**
 * Split a compound command into subcommands.
 * Handles &&, ||, ;, and | (pipes).
 * Does NOT handle quoted strings perfectly — known limitation.
 */
function splitCommand(command) {
    const parts = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];

        if (escaped) { current += ch; escaped = false; continue; }
        if (ch === '\\' && !inSingle) { current += ch; escaped = true; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }

        if (!inSingle && !inDouble) {
            if (ch === '&' && command[i + 1] === '&') { parts.push(current); current = ''; i++; continue; }
            if (ch === '|' && command[i + 1] === '|') { parts.push(current); current = ''; i++; continue; }
            if (ch === ';') { parts.push(current); current = ''; continue; }
            if (ch === '|') { parts.push(current); current = ''; continue; }
        }
        current += ch;
    }
    if (current.trim()) parts.push(current);
    return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Extract the base command name (first word, stripping env vars).
 */
function extractBaseCommand(command) {
    let cmd = command.trim();
    // Strip leading env var assignments: FOO=bar BAZ=qux command
    while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd)) {
        cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
    }
    // Strip common wrapper commands
    for (const wrapper of ['timeout', 'time', 'nice', 'nohup', 'env', 'stdbuf']) {
        const re = new RegExp(`^${wrapper}\\s+(?:-\\S+\\s+)*`);
        if (re.test(cmd)) cmd = cmd.replace(re, '');
    }
    return cmd.split(/\s+/)[0] || '';
}

/**
 * Extract tokens from a command (simple split, respects quotes).
 */
function tokenize(command) {
    const tokens = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (const ch of command) {
        if (escaped) { current += ch; escaped = false; continue; }
        if (ch === '\\' && !inSingle) { escaped = true; current += ch; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if (ch === ' ' && !inSingle && !inDouble) {
            if (current) tokens.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current) tokens.push(current);
    return tokens;
}

// ═══════════════════════════════════════════════════════════════════
// Section 2: Expansion & Injection Detection
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect unquoted glob chars or $VAR expansions that could bypass checks.
 * Ported from readOnlyValidation.ts:containsUnquotedExpansion
 */
function containsUnquotedExpansion(command) {
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && !inSingle) { escaped = true; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if (inSingle) continue;

        // $VAR expansion (inside double quotes AND unquoted)
        if (ch === '$') {
            const next = command[i + 1];
            if (next && /[A-Za-z_@*#?!$0-9-]/.test(next)) return true;
            if (next === '(' || next === '{') return true;
        }

        if (inDouble) continue;
        // Glob chars (only dangerous unquoted)
        if (/[?*\[\]]/.test(ch)) return true;
    }
    return false;
}

/**
 * Detect command substitution patterns.
 */
function containsCommandSubstitution(command) {
    // Backticks
    if (/`/.test(command)) return true;
    // $() — but not inside single quotes
    let inSingle = false;
    for (let i = 0; i < command.length; i++) {
        if (command[i] === "'" && (i === 0 || command[i-1] !== '\\')) inSingle = !inSingle;
        if (!inSingle && command[i] === '$' && command[i+1] === '(') return true;
    }
    return false;
}

function isQuotedMessage(text) {
    const value = String(text || '').trim();
    return /^echo\s+(?:"[^"]*"|'[^']*'|[A-Za-z0-9_ .:-]+)$/.test(value);
}

function isNumericKillCommand(command) {
    const trimmed = String(command || '').trim();
    return /^kill\s+(?:-(?:\d+|[A-Z]+)\s+)?\d+(?:\s+\d+)*\s*(?:2>\s*\/dev\/null)?$/.test(trimmed);
}

function isPortLsofKillSubstitution(command) {
    const trimmed = String(command || '').trim();
    return /^kill\s+(?:-(?:\d+|[A-Z]+)\s+)?\$\(\s*lsof\s+-ti:?\d+\s*\)\s*(?:2>\s*\/dev\/null)?$/.test(trimmed);
}

function isPortLsofXargsKill(command) {
    const trimmed = String(command || '').trim();
    return /^lsof\s+-ti:?\d+\s*\|\s*xargs\s+kill(?:\s+-(?:\d+|[A-Z]+))?\s*(?:2>\s*\/dev\/null)?(?:\s*;\s*echo\s+(?:"[^"]*"|'[^']*'|[A-Za-z0-9_ .:-]+))?$/.test(trimmed);
}

function isApprovedProcessCleanupCommand(command) {
    const trimmed = String(command || '').trim();
    if (!trimmed) return false;
    if (isPortLsofXargsKill(trimmed)) return true;
    const segments = splitCommand(trimmed);
    if (segments.length === 0) return false;
    return segments.every(segment => {
        const sub = segment.trim();
        return isNumericKillCommand(sub) ||
            isPortLsofKillSubstitution(sub) ||
            isPortLsofXargsKill(sub) ||
            isQuotedMessage(sub);
    });
}

// ═══════════════════════════════════════════════════════════════════
// Section 3: Read-Only Command Allowlist
// ═══════════════════════════════════════════════════════════════════

/**
 * Commands that are ALWAYS safe (read-only, no dangerous flags).
 * From readOnlyValidation.ts:READONLY_COMMANDS
 */
const ALWAYS_SAFE = new Set([
    // File content viewing
    'cat', 'head', 'tail', 'wc', 'stat', 'strings', 'hexdump', 'od', 'nl',
    // System info
    'id', 'uname', 'free', 'df', 'du', 'locale', 'groups', 'nproc', 'uptime', 'cal',
    // Path info
    'basename', 'dirname', 'realpath', 'readlink',
    // Text processing (read-only)
    'cut', 'paste', 'tr', 'column', 'tac', 'rev', 'fold', 'expand', 'unexpand',
    'fmt', 'comm', 'cmp', 'numfmt', 'diff',
    // Boolean
    'true', 'false',
    // Misc safe
    'sleep', 'which', 'type', 'expr', 'test', 'getconf', 'seq', 'tsort', 'pr',
    // Checksums
    'sha256sum', 'sha1sum', 'md5sum',
]);

/** Exact-match safe commands (no args allowed or specific pattern). */
const EXACT_SAFE = new Set([
    'pwd', 'whoami', 'arch', 'alias',
    'node -v', 'node --version',
    'python --version', 'python3 --version',
]);

/**
 * Commands with allowed flags — allowlist approach.
 * Key: command name (or "git diff" for multi-word).
 * Value: { flags: { flagName: 'none'|'string'|'number' } }
 *
 * From readOnlyValidation.ts:COMMAND_ALLOWLIST (subset of most important).
 */
const COMMAND_ALLOWLIST = {
    // ── Git read-only commands ──
    'git status':  { flags: { '-s': 'none', '--short': 'none', '-b': 'none', '--branch': 'none', '--porcelain': 'none', '-u': 'string', '--untracked-files': 'string', '--ignored': 'none', '-z': 'none', '--column': 'string', '--no-column': 'none', '--ahead-behind': 'none', '--no-ahead-behind': 'none', '--renames': 'none', '--no-renames': 'none' } },
    'git diff':    { flags: { '--stat': 'none', '--numstat': 'none', '--shortstat': 'none', '--name-only': 'none', '--name-status': 'none', '--cached': 'none', '--staged': 'none', '-w': 'none', '--ignore-all-space': 'none', '-b': 'none', '--ignore-space-change': 'none', '--no-color': 'none', '--color': 'string', '-U': 'number', '--unified': 'number', '--diff-filter': 'string', '--no-ext-diff': 'none', '--no-renames': 'none', '-R': 'none', '--relative': 'string', '--src-prefix': 'string', '--dst-prefix': 'string' } },
    'git log':     { flags: { '--oneline': 'none', '-n': 'number', '--max-count': 'number', '--pretty': 'string', '--format': 'string', '--graph': 'none', '--all': 'none', '--stat': 'none', '--name-only': 'none', '--name-status': 'none', '--abbrev-commit': 'none', '--no-decorate': 'none', '--decorate': 'string', '--first-parent': 'none', '--merges': 'none', '--no-merges': 'none', '--after': 'string', '--before': 'string', '--since': 'string', '--until': 'string', '--author': 'string', '--grep': 'string', '--follow': 'none', '-p': 'none', '--patch': 'none', '--reverse': 'none', '--topo-order': 'none', '--date-order': 'none', '--date': 'string' } },
    'git show':    { flags: { '--stat': 'none', '--name-only': 'none', '--name-status': 'none', '--pretty': 'string', '--format': 'string', '--no-patch': 'none', '--no-notes': 'none', '-s': 'none', '--abbrev-commit': 'none' } },
    'git branch':  { flags: { '-a': 'none', '--all': 'none', '-r': 'none', '--remotes': 'none', '-v': 'none', '--verbose': 'none', '-vv': 'none', '--list': 'string', '--contains': 'string', '--merged': 'string', '--no-merged': 'string', '--sort': 'string', '--color': 'string', '--no-color': 'none', '--column': 'string', '--no-column': 'none' } },
    'git blame':   { flags: { '-L': 'string', '-w': 'none', '-M': 'none', '-C': 'none', '--no-progress': 'none', '--date': 'string', '-e': 'none', '--show-email': 'none', '-p': 'none', '--porcelain': 'none', '--line-porcelain': 'none' } },
    'git ls-files': { flags: { '-m': 'none', '--modified': 'none', '-d': 'none', '--deleted': 'none', '-o': 'none', '--others': 'none', '-i': 'none', '--ignored': 'none', '-s': 'none', '--stage': 'none', '-c': 'none', '--cached': 'none', '--exclude-standard': 'none', '-z': 'none', '--full-name': 'none', '--error-unmatch': 'none' } },
    'git remote':  { flags: { '-v': 'none', '--verbose': 'none' } },
    'git tag':     { flags: { '-l': 'string', '--list': 'string', '-n': 'number', '--sort': 'string', '--contains': 'string', '--no-contains': 'string', '--merged': 'string', '--no-merged': 'string', '--column': 'string', '--no-column': 'none', '--color': 'string' } },
    'git stash list': { flags: { '--pretty': 'string', '--format': 'string', '-n': 'number' } },
    'git config':  { flags: { '--get': 'string', '--get-all': 'string', '--list': 'none', '-l': 'none', '--global': 'none', '--local': 'none', '--system': 'none' } },
    'git rev-parse': { flags: { '--short': 'none', '--abbrev-ref': 'none', '--show-toplevel': 'none', '--git-dir': 'none', '--is-inside-work-tree': 'none', '--is-bare-repository': 'none', 'HEAD': 'none' } },

    // ── grep/ripgrep ──
    grep: { flags: { '-r': 'none', '-R': 'none', '--recursive': 'none', '-i': 'none', '--ignore-case': 'none', '-n': 'none', '--line-number': 'none', '-l': 'none', '--files-with-matches': 'none', '-L': 'none', '--files-without-match': 'none', '-c': 'none', '--count': 'none', '-v': 'none', '--invert-match': 'none', '-w': 'none', '--word-regexp': 'none', '-x': 'none', '--line-regexp': 'none', '-E': 'none', '--extended-regexp': 'none', '-F': 'none', '--fixed-strings': 'none', '-P': 'none', '--perl-regexp': 'none', '-o': 'none', '--only-matching': 'none', '-m': 'number', '--max-count': 'number', '-A': 'number', '--after-context': 'number', '-B': 'number', '--before-context': 'number', '-C': 'number', '--context': 'number', '-H': 'none', '--with-filename': 'none', '-h': 'none', '--no-filename': 'none', '--include': 'string', '--exclude': 'string', '--exclude-dir': 'string', '--color': 'string', '-q': 'none', '--quiet': 'none', '-s': 'none', '--no-messages': 'none' } },
    rg: { flags: { '-i': 'none', '--ignore-case': 'none', '-S': 'none', '--smart-case': 'none', '-w': 'none', '--word-regexp': 'none', '-x': 'none', '--line-regexp': 'none', '-c': 'none', '--count': 'none', '-l': 'none', '--files-with-matches': 'none', '--files-without-match': 'none', '-n': 'none', '--line-number': 'none', '-N': 'none', '--no-line-number': 'none', '-H': 'none', '--with-filename': 'none', '--no-filename': 'none', '-o': 'none', '--only-matching': 'none', '-m': 'number', '--max-count': 'number', '-A': 'number', '--after-context': 'number', '-B': 'number', '--before-context': 'number', '-C': 'number', '--context': 'number', '-t': 'string', '--type': 'string', '-T': 'string', '--type-not': 'string', '-g': 'string', '--glob': 'string', '--iglob': 'string', '-F': 'none', '--fixed-strings': 'none', '-P': 'none', '--pcre2': 'none', '-U': 'none', '--multiline': 'none', '--multiline-dotall': 'none', '-u': 'none', '--unrestricted': 'none', '--hidden': 'none', '--no-ignore': 'none', '-L': 'none', '--follow': 'none', '--color': 'string', '--colors': 'string', '-p': 'none', '--pretty': 'none', '-j': 'number', '--threads': 'number', '--max-depth': 'number', '-M': 'number', '--max-columns': 'number', '--sort': 'string', '--sortr': 'string', '-e': 'string', '--regexp': 'string', '--heading': 'none', '--no-heading': 'none', '-q': 'none', '--quiet': 'none', '--trim': 'none', '--vimgrep': 'none', '--json': 'none', '--stats': 'none' } },

    // ── find (read-only subset — NO -exec, -delete, -fprint) ──
    find: { flags: { '-name': 'string', '-iname': 'string', '-path': 'string', '-ipath': 'string', '-type': 'string', '-maxdepth': 'number', '-mindepth': 'number', '-newer': 'string', '-size': 'string', '-mtime': 'string', '-atime': 'string', '-ctime': 'string', '-perm': 'string', '-user': 'string', '-group': 'string', '-not': 'none', '!': 'none', '-or': 'none', '-o': 'none', '-and': 'none', '-a': 'none', '-print': 'none', '-print0': 'none', '-empty': 'none', '-readable': 'none', '-writable': 'none', '-executable': 'none', '-follow': 'none', '-L': 'none', '-P': 'none', '-H': 'none', '-xdev': 'none', '-mount': 'none', '-daystart': 'none', '-regextype': 'string', '-regex': 'string', '-iregex': 'string' },
        blocked: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fls', '-fprintf'] },

    // ── sed (read-only subset — NO -i/--in-place) ──
    sed: { flags: { '-n': 'none', '--quiet': 'none', '--silent': 'none', '-E': 'none', '-r': 'none', '--regexp-extended': 'none', '-e': 'string', '--expression': 'string', '-f': 'string', '--file': 'string', '-l': 'number', '--line-length': 'number', '-u': 'none', '--unbuffered': 'none' },
        blocked: ['-i', '--in-place', '-z', '--null-data', '-s', '--separate'] },

    // ── ls ──
    ls: { flags: { '-l': 'none', '-a': 'none', '-A': 'none', '-h': 'none', '--human-readable': 'none', '-R': 'none', '--recursive': 'none', '-S': 'none', '-t': 'none', '-r': 'none', '--reverse': 'none', '-1': 'none', '-d': 'none', '--directory': 'none', '-F': 'none', '--classify': 'none', '-i': 'none', '--inode': 'none', '-s': 'none', '--size': 'none', '--color': 'string', '--sort': 'string', '--time': 'string', '--group-directories-first': 'none', '-p': 'none', '-G': 'none', '-n': 'none', '--numeric-uid-gid': 'none' } },

    // ── sort, uniq, jq ──
    sort: { flags: { '-n': 'none', '--numeric-sort': 'none', '-r': 'none', '--reverse': 'none', '-u': 'none', '--unique': 'none', '-k': 'string', '--key': 'string', '-t': 'string', '--field-separator': 'string', '-f': 'none', '--ignore-case': 'none', '-h': 'none', '--human-numeric-sort': 'none', '-V': 'none', '--version-sort': 'none', '-s': 'none', '--stable': 'none', '-c': 'none', '--check': 'none', '-m': 'none', '--merge': 'none' } },
    uniq: { flags: { '-c': 'none', '--count': 'none', '-d': 'none', '--repeated': 'none', '-u': 'none', '--unique': 'none', '-i': 'none', '--ignore-case': 'none', '-f': 'number', '--skip-fields': 'number', '-s': 'number', '--skip-chars': 'number', '-w': 'number', '--check-chars': 'number' } },

    // ── Process/system inspection ──
    ps: { flags: { '-e': 'none', '-A': 'none', '-a': 'none', '-f': 'none', '-F': 'none', '-l': 'none', '-j': 'none', '-w': 'none', '-ww': 'none', '-H': 'none', '--forest': 'none', '--headers': 'none', '--no-headers': 'none', '--sort': 'string', '-L': 'none', '-T': 'none', '-m': 'none', '-C': 'string', '-p': 'string', '--pid': 'string', '-u': 'string', '--user': 'string', '-t': 'string', '--tty': 'string' } },
    pgrep: { flags: { '-l': 'none', '--list-name': 'none', '-a': 'none', '--list-full': 'none', '-c': 'none', '--count': 'none', '-f': 'none', '--full': 'none', '-i': 'none', '--ignore-case': 'none', '-n': 'none', '--newest': 'none', '-o': 'none', '--oldest': 'none', '-u': 'string', '--euid': 'string', '-x': 'none', '--exact': 'none' } },
    lsof: { flags: { '-i': 'none', '-n': 'none', '-P': 'none', '-t': 'none', '-p': 'string', '-c': 'string', '-u': 'string' } },
    netstat: { flags: { '-a': 'none', '-n': 'none', '-l': 'none', '-t': 'none', '-u': 'none', '-p': 'none', '-r': 'none', '-s': 'none', '-i': 'none', '-g': 'none' } },

    // ── tree ──
    tree: { flags: { '-a': 'none', '-d': 'none', '-l': 'none', '-f': 'none', '-L': 'number', '-P': 'string', '-I': 'string', '--gitignore': 'none', '-p': 'none', '-u': 'none', '-g': 'none', '-s': 'none', '-h': 'none', '-D': 'none', '-F': 'none', '-n': 'none', '-C': 'none', '-J': 'none', '-X': 'none', '-i': 'none', '-r': 'none', '-t': 'none', '-v': 'none', '--dirsfirst': 'none', '--filesfirst': 'none', '--noreport': 'none', '--charset': 'string', '--filelimit': 'number', '--sort': 'string' },
        blocked: ['-o', '--output'] }, // -o writes to file

    // ── man, date, hostname, file, base64 ──
    man:  { flags: { '-a': 'none', '-f': 'none', '-k': 'none', '-w': 'none', '-S': 'string', '-s': 'string' } },
    date: { flags: { '-d': 'string', '--date': 'string', '-r': 'string', '--reference': 'string', '-u': 'none', '--utc': 'none', '-R': 'none', '-I': 'none', '--iso-8601': 'string', '--rfc-3339': 'string' },
        blocked: ['-s', '--set', '-f', '--file'] },
    file: { flags: { '-b': 'none', '--brief': 'none', '-i': 'none', '--mime': 'none', '--mime-type': 'none', '--mime-encoding': 'none', '-L': 'none', '-h': 'none', '-k': 'none', '-z': 'none' } },
    base64: { flags: { '-d': 'none', '-D': 'none', '--decode': 'none', '-w': 'number', '--wrap': 'number', '-b': 'number', '--break': 'number' } },
};

// ═══════════════════════════════════════════════════════════════════
// Section 4: Contained Commands (need .venv/sandbox)
// ═══════════════════════════════════════════════════════════════════

/** Commands that modify host state — need contained execution. */
const CONTAINED_COMMANDS = new Set([
    // Test runners
    'pytest', 'jest', 'vitest', 'mocha', 'karma',
    'cargo test', 'go test', 'dotnet test',
    'npm test', 'npm run test', 'yarn test', 'pnpm test',
    // Build systems
    'make', 'cmake', 'gradle', 'mvn', 'ant',
    'npm run build', 'npm run dev', 'npm run start',
    'yarn build', 'pnpm build',
    'cargo build', 'cargo run', 'go build', 'go run',
    'dotnet build', 'dotnet run',
    // Package managers (install)
    'pip install', 'pip3 install',
    'npm install', 'npm i', 'npm ci',
    'yarn install', 'yarn add',
    'pnpm install', 'pnpm add',
    'cargo add',
    // Script execution
    'python', 'python3', 'node', 'deno', 'bun',
    'ruby', 'perl', 'php',
    // Linters with fix mode
    'ruff check --fix', 'ruff format',
    'eslint --fix', 'prettier --write',
    'black', 'autopep8', 'isort',
]);

/**
 * Check if a command starts with any contained pattern.
 */
function isContainedCommand(command) {
    const trimmed = command.trim();
    for (const pattern of CONTAINED_COMMANDS) {
        if (trimmed === pattern || trimmed.startsWith(pattern + ' ') || trimmed.startsWith(pattern + '\t')) {
            return true;
        }
    }
    // python/node with file args (not -c/-e which are inline)
    if (/^(python3?|node)\s+[^-]/.test(trimmed)) return true;
    return false;
}

// ═══════════════════════════════════════════════════════════════════
// Section 5: Blocked Commands (always need HITL approval)
// ═══════════════════════════════════════════════════════════════════

/** Shell patterns that are ALWAYS blocked. */
const BLOCKED_PATTERNS = [
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
    /\bfind\s+\/(?:\s|$)/,                                    // find / scans the whole VM
    /find\s.*-exec/,                                           // find with -exec (code execution)
    /find\s.*-delete/,                                         // find with -delete
];

/** Commands that need HITL approval even if not blocked. */
const HIGH_RISK_PATTERNS = [
    /\brm\s/,
    /\bunlink\s/,
    /\brmdir\s/,
    /git\s+push\s+--force/,
    /git\s+reset\s+--hard/,
    /git\s+clean\s+-[fd]/,
    /drop\s+table/i,
    /drop\s+database/i,
    /truncate\s+table/i,
    /sudo\s/,
    /chmod\s/,
    /chown\s/,
    /\bkill\s/,
    /\bpkill\s/,
    /systemctl\s/,
    /launchctl\s/,
];

// ═══════════════════════════════════════════════════════════════════
// Section 6: Flag Validation
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate that a command only uses allowed flags from the allowlist.
 * Ported from readOnlyValidation.ts:validateFlags (simplified).
 *
 * @param {string[]} tokens - Tokenized command
 * @param {number} startIdx - Index after the command name tokens
 * @param {object} config - { flags: {...}, blocked?: [...] }
 * @returns {boolean} true if all flags are safe
 */
function validateFlags(tokens, startIdx, config) {
    const { flags, blocked } = config;

    for (let i = startIdx; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token) continue;

        // Reject any token with $ (variable expansion)
        if (token.includes('$')) return false;

        // Reject brace expansion
        if (token.includes('{') && (token.includes(',') || token.includes('..'))) return false;

        // Check blocked flags
        if (blocked) {
            for (const b of blocked) {
                if (token === b || token.startsWith(b + '=')) return false;
                if (/^-[A-Za-z]$/.test(b) && token.startsWith(b) && token.length > b.length) return false;
            }
        }

        if (token.startsWith('--')) {
            // Long flag
            const eqIdx = token.indexOf('=');
            const flagName = eqIdx > 0 ? token.slice(0, eqIdx) : token;
            if (flagName === '--') break; // end of flags

            if (!(flagName in flags)) return false; // unknown flag

            const flagType = flags[flagName];
            if (flagType !== 'none' && eqIdx === -1) {
                // Flag needs an argument — consume next token
                i++;
            }
        } else if (token.startsWith('-') && token.length > 1) {
            // Short flag — could be bundled (-abc = -a -b -c)
            // For simplicity, check if exact flag is known
            if (token in flags) {
                const flagType = flags[token];
                if (flagType !== 'none') i++; // consume arg
            } else {
                // Try unbundling: -abc → check each char
                let allKnown = true;
                for (let j = 1; j < token.length; j++) {
                    const shortFlag = `-${token[j]}`;
                    if (!(shortFlag in flags)) { allKnown = false; break; }
                }
                if (!allKnown) {
                    // Check if it's a flag with attached value like -n5
                    const shortFlag = `-${token[1]}`;
                    if (shortFlag in flags && flags[shortFlag] !== 'none') {
                        // -n5 → flag -n with value 5, OK
                    } else {
                        return false; // unknown flag
                    }
                }
            }
        }
        // Positional args are allowed (file paths, patterns, etc.)
    }

    return true;
}

/**
 * Check if a single command is read-only via the allowlist.
 */
function isCommandSafeViaAllowlist(command) {
    const trimmed = command.trim();
    const tokens = tokenize(trimmed);
    if (tokens.length === 0) return false;

    // Check multi-word commands first (e.g., "git diff", "git stash list")
    for (const [cmdPattern, config] of Object.entries(COMMAND_ALLOWLIST)) {
        const cmdTokens = cmdPattern.split(' ');
        if (tokens.length >= cmdTokens.length) {
            let matches = true;
            for (let j = 0; j < cmdTokens.length; j++) {
                if (tokens[j] !== cmdTokens[j]) { matches = false; break; }
            }
            if (matches) {
                return validateFlags(tokens, cmdTokens.length, config);
            }
        }
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════════
// Section 7: Main Classifier
// ═══════════════════════════════════════════════════════════════════

/**
 * Command exit code semantics — some commands use non-zero for non-error.
 * Ported from commandSemantics.ts
 */
const EXIT_CODE_SEMANTICS = {
    grep:  (code) => code >= 2,  // 1 = no matches (not error)
    rg:    (code) => code >= 2,
    find:  (code) => code >= 2,  // 1 = partial success
    diff:  (code) => code >= 2,  // 1 = differences found
    test:  (code) => code >= 2,  // 1 = condition false
};

/**
 * Classify a shell command.
 *
 * @param {string} command - The raw command string
 * @returns {{ classification: 'safe'|'contained'|'blocked', reason: string, highRisk?: boolean }}
 */
export function classifyCommand(command) {
    if (!command || !command.trim()) {
        return { classification: 'blocked', reason: 'Empty command' };
    }

    const trimmed = command.trim();

    if (isApprovedProcessCleanupCommand(trimmed)) {
        return {
            classification: 'contained',
            reason: 'Process cleanup by numeric PID or lsof port lookup; requires approval',
            highRisk: true,
        };
    }

    // ── Step 1: Check for always-blocked patterns ──
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { classification: 'blocked', reason: `Dangerous pattern: ${trimmed.slice(0, 60)}` };
        }
    }

    // ── Step 2: Check for command substitution / injection ──
    if (containsCommandSubstitution(trimmed)) {
        return { classification: 'blocked', reason: 'Contains command substitution (backticks or $())' };
    }

    if (containsUnsafeOutputRedirection(trimmed)) {
        return { classification: 'contained', reason: 'Writes shell output via redirection' };
    }

    // ── Step 3: Split compound commands and classify each ──
    const subcommands = splitCommand(trimmed);

    // If any subcommand is blocked, the whole thing is blocked
    // If any subcommand is contained, the whole thing is contained
    // Only safe if ALL subcommands are safe
    let worstLevel = 'safe'; // safe < contained < blocked

    for (const subcmd of subcommands) {
        const sub = subcmd.trim();
        if (!sub) continue;

        const subResult = classifySingleCommand(sub);
        if (subResult.classification === 'blocked') {
            return subResult; // immediately blocked
        }
        if (subResult.classification === 'contained' && worstLevel === 'safe') {
            worstLevel = 'contained';
        }
    }

    // ── Step 4: Check for high-risk patterns (escalate to blocked) ──
    let highRisk = false;
    for (const pattern of HIGH_RISK_PATTERNS) {
        if (pattern.test(trimmed)) {
            highRisk = true;
            // High-risk patterns escalate contained → blocked
            if (worstLevel !== 'blocked') worstLevel = 'blocked';
            break;
        }
    }

    return {
        classification: worstLevel,
        reason: worstLevel === 'safe' ? 'All subcommands are read-only' : 'Contains write/execute or high-risk operations',
        highRisk,
    };
}

function containsUnsafeOutputRedirection(command) {
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && !inSingle) { escaped = true; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if (inSingle || inDouble || ch !== '>') continue;

        const prev = command[i - 1] || '';
        const next = command[i + 1] || '';
        if (next === '&') continue;
        let cursor = next === '>' ? i + 2 : i + 1;
        while (/\s/.test(command[cursor] || '')) cursor++;
        const target = command.slice(cursor).match(/^[^\s;&|]+/)?.[0] || '';
        if (target === '/dev/null') continue;
        if (prev === '2' && target === '/dev/null') continue;
        return true;
    }
    return false;
}

/**
 * Classify a single (non-compound) command.
 */
function classifySingleCommand(command) {
    const trimmed = command.trim();
    const baseCmd = extractBaseCommand(trimmed);

    // ── Exact matches ──
    if (EXACT_SAFE.has(trimmed)) {
        return { classification: 'safe', reason: `Exact safe match: ${trimmed}` };
    }

    // ── Always-safe simple commands ──
    if (ALWAYS_SAFE.has(baseCmd)) {
        // Check for unquoted expansion that could bypass safety
        if (containsUnquotedExpansion(trimmed)) {
            return { classification: 'contained', reason: `${baseCmd} with variable/glob expansion` };
        }
        return { classification: 'safe', reason: `Read-only command: ${baseCmd}` };
    }

    // ── Allowlist-based flag validation ──
    if (isCommandSafeViaAllowlist(trimmed)) {
        if (containsUnquotedExpansion(trimmed)) {
            return { classification: 'contained', reason: `${baseCmd} with variable/glob expansion` };
        }
        return { classification: 'safe', reason: `Allowlisted with safe flags: ${baseCmd}` };
    }

    // ── Contained commands (test, build, install, script execution) ──
    if (isContainedCommand(trimmed)) {
        return { classification: 'contained', reason: `Needs contained execution: ${baseCmd}` };
    }

    // ── Linters without --fix (read-only) ──
    if (/^(ruff check|mypy|pyright|pylint|flake8|tsc --noEmit|eslint(?!\s+--fix))/.test(trimmed)) {
        if (containsUnquotedExpansion(trimmed)) {
            return { classification: 'contained', reason: 'Linter with expansion' };
        }
        return { classification: 'safe', reason: `Read-only linter: ${baseCmd}` };
    }

    // ── cd (safe but changes state) ──
    if (/^cd(?:\s|$)/.test(trimmed)) {
        if (containsUnquotedExpansion(trimmed)) {
            return { classification: 'contained', reason: 'cd with expansion' };
        }
        return { classification: 'safe', reason: 'Change directory' };
    }

    // ── echo (safe if no expansion) ──
    if (/^echo\s/.test(trimmed) && !containsUnquotedExpansion(trimmed)) {
        return { classification: 'safe', reason: 'Echo without expansion' };
    }

    // ── Default: contained (unknown command, not explicitly blocked) ──
    return { classification: 'contained', reason: `Unknown command, defaulting to contained: ${baseCmd}` };
}

/**
 * Check if a command exit code represents an error (semantic-aware).
 */
export function isExitCodeError(command, exitCode) {
    const baseCmd = extractBaseCommand(command);
    const semantic = EXIT_CODE_SEMANTICS[baseCmd];
    if (semantic) return semantic(exitCode);
    return exitCode !== 0;
}

// Re-export for use in tool-executor
export { splitCommand, extractBaseCommand, tokenize, containsUnquotedExpansion };
