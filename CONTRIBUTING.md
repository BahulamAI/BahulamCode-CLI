# Contributing to Bahulam Code

## Getting started

```bash
git clone https://github.com/BahulamAI/BahulamCode-CLI
cd BahulamCode-CLI
npm install
npm test          # 33 unit tests, no auth required, ~30s
```

Node 18 or later. No external services or API keys needed to run unit tests.

## Branch naming

- Bug fixes: `fix/{short-description}` — e.g. `fix/noop-edit-success`, `fix/resume-hydration-formatting`
- Features: `{number}_{short-description}` — e.g. `217_cli_disk_memory`, `222_ui_fixes`

## Code style

- ES modules only (`type: "module"`)
- No external linting dependencies — match the style of the file you're editing
- Env vars: `BAHULAM_` prefix only. `KEPLER_` is retired.

## What belongs in a PR

**Do include:**
- Bug fixes with a regression test
- New tools or tool improvements with unit tests (happy path + at least one error case)
- UI/rendering changes with assertions in `test/test-terminal-rendering.mjs`
- New instruction file formats — add to `src/core/system-prompt.mjs` and cover in `test/test-bahulam-contract.mjs`

**Do not include:**
- Changes that require Bahulam backend credentials to test
- New `KEPLER_*` env vars — use `BAHULAM_*`
- Internal PRD smoke tests — use the integration test pattern instead
- External npm dependencies (keep it zero-dependency beyond Node builtins)

## Test standards

### Unit tests (`test/test-*.mjs`)

`npm test` runs 33 unit tests. Every unit test must:

1. **Run standalone** — `node test/test-foo.mjs` with no special flags
2. **Use the built-in pattern** — no third-party test frameworks:

```js
import assert from 'node:assert';
let passed = 0, failed = 0;

function test(name, fn) {
    return fn()
        .then(() => { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; })
        .catch(err => { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`); failed++; });
}

console.log('\ntest-foo.mjs\n');
await test('does the thing', async () => {
    assert.strictEqual(foo('input'), 'expected');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

3. **Isolate disk writes** — set `BAHULAM_HOME` to a temp dir, never touch `~/.bahulam/`:

```js
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-test-'));
process.env.BAHULAM_HOME = path.join(tmp, 'home');
// ... test ...
fs.rmSync(tmp, { recursive: true, force: true });
```

4. **Mock network** — mock `globalThis.fetch` for any code that calls the API; no real tokens
5. **Name the file** `test/test-<module>.mjs` matching `src/<path>/<module>.mjs`

### Integration tests (opt-in)

Integration tests spawn real processes or bind sockets. They are excluded from `npm test`:

```bash
npm run test:integration
```

Name them `test/test-session-*.mjs` or `test/test-socket-*.mjs`. They may fail without daemon modules or writable `/tmp/`.

### Test file naming convention

| Pattern | Type | Runs in `npm test` |
|---|---|---|
| `test/test-<module>.mjs` | Unit — tests `src/<module>.mjs` | Yes |
| `test/test-session-*.mjs` | Integration — multi-process sessions | No |
| `test/test-socket-*.mjs` | Integration — Unix socket server | No |
| `test/e2e-*.mjs` | E2E — requires running backend | No |

## Instruction file support

The CLI loads project instructions in this order (parent dir → child dir):

| File | Role | Compatible agents |
|---|---|---|
| `AGENTS.md` | Universal project baseline — build rules, style, monorepo layout | Bahulam, Cursor, Copilot CLI, Gemini CLI, Claude Code |
| `BAHULAM.md` | Bahulam-native memory — persistent context, preferences | Bahulam |
| `.bahulam/BAHULAM.md` | Same, inside project config dir | Bahulam |
| `CLAUDE.md` | Claude-specific instructions | Claude Code, Bahulam |

Adding a new format: update `src/core/system-prompt.mjs::loadClaudeMdFiles()` and add a test in `test/test-bahulam-contract.mjs`.

## Memory system

**Cross-session facts** (written by the `remember` tool):
```
~/.bahulam/memory.md          — global, loaded every session
<project>/.bahulam/memory.md  — project-scoped
```

**Instruction files** (you write by hand):
```
AGENTS.md              — universal project baseline
BAHULAM.md             — Bahulam-specific project context
~/.bahulam/BAHULAM.md  — global Bahulam instructions
```

## Skill format (`SKILL.md`)

Skills are loaded on-demand. Each skill is a directory:

```
.bahulam/skills/<skill-name>/
    SKILL.md      # required: frontmatter + instructions
```

```yaml
---
name: my-skill
description: One line shown in the skill picker
triggers:
  - keyword
---

Instructions for the agent go here.
```

## Env var reference

| Name | Purpose |
|---|---|
| `BAHULAM_HOME` | Override `~/.bahulam/` location |
| `BAHULAM_TOOL_NAME` | Hook env: current tool name |
| `BAHULAM_PROJECT_DIR` | Hook env: project root |
| `BAHULAM_SESSION_ID` | Hook env: session id |
| `BAHULAM_TURN_ID` | Hook env: turn id |
| `BAHULAM_VISION_MAX_IMAGE_BYTES` | Max bytes per attached image |
| `BAHULAM_LONG_RUNNING_TIMEOUT_MS` | Observation timeout for shell commands |
| `BAHULAM_STAGNATION_DETECTION` | Enable loop detection (`1`/`0`, default off) |
| `BAHULAM_STAGNATION_THRESHOLD` | Consecutive calls before warning (default `3`) |

## PR checklist

- [ ] `npm test` passes (33 unit tests, 0 failed)
- [ ] New code has a test in `test/test-<module>.mjs`
- [ ] No real API tokens in tests — use placeholder strings
- [ ] Instruction file changes covered by `test/test-bahulam-contract.mjs`

## Reporting issues

Open an issue at https://github.com/BahulamAI/BahulamCode-CLI/issues. Include your OS, Node version, and steps to reproduce.

## License

Contributions are licensed under the Apache 2.0 License.
