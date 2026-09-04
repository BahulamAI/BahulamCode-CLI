# Pi Compat — Engineering Plan

**Status:** Design (approved 2026-09-02)
**Owner:** TBD
**Estimate:** 8–10 engineering days for `mode: tools` (Sprint 1 Track B). +2 days for `mode: sub_agent` if built in Sprint 1; otherwise deferred to Sprint 3.
**Downstream deliverable:** validated pi plugin import → composed `manim-studio` proof

## Why we're doing this

Bahulam packs compose ingredients from three sources — our authored tools, MCP servers, and pi ecosystem packages. Pi has ~5,617 packages of commodity domain wrappers (ffmpeg, YouTube API, Ahrefs, backtest libs, etc.). Composing them into our packs is the difference between shipping a vertical Studio in ~2 weeks vs ~6 weeks per domain. We monetize the assembly + delivery + hosted execution; pi authors get community + adoption. This is not a competitor adoption — it's an ingredient supply chain.

## What "composition" means concretely

A pack's `plugin.yaml` declares pi packages under `config.composes:`. The runtime installs each pi package, discovers its tools, and exposes them to the pack's agents through our existing tool executor. Our loop drives everything; the pi handlers execute inside our process.

Native `config.tools` are optional. We should not author wrapper tools for every pi package. A Bahulam pack can be composed-only: agents + prompts + `config.composes` + optional workspace views. Author native tools only when the pack needs Bahulam-owned persistence, domain glue, post-processing, policy wrapping, or workspace-facing state changes.

```yaml
config:
  workspace: ./config/workspace.yaml       # entry agent
  agents_from: ./config/agents/            # optional delegated subagents
  tools: [...]                              # optional authored tools for state/glue
  composes:
    - source: pi:@ffmpeg/transitions@^2.0.0
      as: fx                                # namespace prefix, e.g. fx__add_transitions
      expose: [add_transitions, add_captions]
      verified: true
    - source: pi:@complex/orchestrator@^2.0.0
      mode: sub_agent                       # escape hatch (Sprint 3+)
      expose_as_agent: complex-specialist
  mcpServers: {...}                         # (unchanged)
  views: [...]
```

## What already exists (audit)

We already have the contract layer. Reading `src/plugins/pi-compose.mjs` confirms:

- `parsePiSource(source)` — parses `pi:@scope/pkg@^1.0.0` into `{package_name, version_range}` (handles scoped-vs-flat npm names correctly)
- `normalizeCompose(def, index)` / `normalizeComposes(value)` — normalize `config.composes[]` entries
- `composedToolName(compose, exposed)` — computes `<namespace>.<exposed>` when `as:` is present, flat otherwise
- `validateCompose(compose)` — validates source URI, `as:` namespace shape, `expose[]` list; returns `{errors, warnings}`
- `expandComposedTools(pluginName, pluginDir, composes)` — turns composes into placeholder tool records with `_composed` metadata

Preflight (`src/plugins/preflight.mjs`) already integrates this:
- Rejects duplicate composed tool names
- Rejects composed tools that shadow built-ins (`RESERVED_TOOL_NAMES`)
- Rejects `as:` namespace collisions with MCP server names
- Rejects native tools colliding with composed tools

**What's missing** (this plan builds): install/fetch, load-time tool discovery via the shim, executor wiring so composed tool invocations actually run pi handlers, verified registry cross-check, `mode: sub_agent` delegation, docs, selftest.

## Delivery — 8 concrete steps

### Step 1 — `pi:` install source (~1 day)

**File:** `src/commands/plugin-manage.mjs`

Extend `classifySource()` (around line 118). Route `pi:` sources to a new `installFromPi(spec, opts)`:

```js
if (/^pi:/.test(source)) {
  const parsed = parsePiSource(source);           // reuse pi-compose.mjs
  if (!parsed) return { kind: 'invalid' };
  return { kind: 'pi', spec: parsed.spec, packageName: parsed.package_name, versionRange: parsed.version_range };
}
```

**New:** `installFromPi({ packageName, versionRange, targetDir, force })`:
- Resolve to `~/.bahulam/plugins-pi/<name>/`
- Use `npm pack <packageName>@<versionRange>` (fallback to `<packageName>` if no version)
- Extract tarball into the target dir
- Write our stamp: `{ origin: { kind: 'pi', spec, packageName, versionRange, resolvedVersion } }`
- Wire into the existing rollback machinery (any error → rm target dir)

**Reuse:** existing stamp / rollback / force-overwrite behavior from `installFromTarball`.

### Step 2 — Pi manifest reader + tool discovery cache (~1 day)

**Why cached:** pi extensions register tools **imperatively at load time** (`registerTool(name, schema, handler)`), so we can't know what tools an extension exposes from `package.json` alone. Solution: on first install, run the extension in a **probe load** via the shim (Step 3), capture the tools it registers, cache to `<pi-dir>/.bahulam-tools.json`.

**Constant already exported:** `PI_TOOLS_CACHE = '.bahulam-tools.json'` in `pi-compose.mjs`.

**New file:** `src/plugins/pi-compat/discovery.mjs`

```js
export async function discoverPiTools(pluginDir) {
  const cachePath = path.join(pluginDir, PI_TOOLS_CACHE);
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));

  const captured = await probePiExtension(pluginDir);       // Step 3
  const shape = {
    tools: captured.tools.map(t => ({ name: t.name, description: t.description || '', input_schema: t.schema || {} })),
    commands: captured.commands.map(c => ({ command: c.cmd })),
    discovered_at: new Date().toISOString(),
  };
  fs.writeFileSync(cachePath, JSON.stringify(shape, null, 2));
  return shape;
}
```

First install: ~1–2 seconds probe. Subsequent lookups: instant.

### Step 3 — The pi runtime shim (~2–3 days, load-bearing)

**Why this is the hard part:** pi extensions do `import { pi } from 'pi'` and call `pi.registerTool(...)`. We need to intercept that import and return a synthetic module that captures the calls.

**Two implementation options:**

**Option A — Node ESM loader hook (preferred, `--import` flag).** Register a loader that resolves the module specifier `'pi'` to a virtual module URL, which returns our shim. Cleanest, but requires the CLI to spawn a child Node process with `--import ./src/plugins/pi-compat/loader-hook.mjs`.

**Option B — In-process import interception via `import-map` polyfill or vm.SourceTextModule.** More complex, but avoids spawning a child. Not recommended for v1.

**Recommendation: Option A.** Probe loads (Step 2) spawn a child; runtime loads use the same mechanism. Loader-hook file is trivial (~30 lines).

**New file:** `src/plugins/pi-compat/shim.mjs`

```js
export function createPiShim({ pluginName, captured }) {
  return {
    registerTool(name, schema, handler) {
      captured.tools.push({ name, schema, handler });
    },
    registerCommand(cmd, handler) {
      captured.commands.push({ cmd, handler });          // captured; not surfaced in v1
    },
    events: {
      on: () => { /* no-op in v1 */ },
      emit: () => { /* no-op in v1 */ },
    },
    ctx: {
      ui: {
        setWidget: (widget) => {
          if (process.env.DEBUG) console.warn(`[pi:${pluginName}] widget ignored: ${widget?.title || 'untitled'}`);
        },
        custom: () => { /* no-op */ },
      },
      log: (...args) => console.error(`[pi:${pluginName}]`, ...args),
    },
  };
}
```

**New file:** `src/plugins/pi-compat/loader-hook.mjs`

```js
// Node --import hook: resolves `pi` module specifier to a virtual URL,
// loads returns our shim source. State passed via env vars set by parent.
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'pi') return { shortCircuit: true, url: 'bahulam-pi-shim:v1' };
  return nextResolve(specifier, context);
}
export function load(url, context, nextLoad) {
  if (url === 'bahulam-pi-shim:v1') {
    return { shortCircuit: true, format: 'module', source: `
      import { createPiShim } from '${SHIM_MODULE_URL}';
      const captured = globalThis.__bahulam_pi_captured;
      export const pi = createPiShim({ pluginName: process.env.BAHULAM_PI_PLUGIN, captured });
    `};
  }
  return nextLoad(url, context);
}
```

**Probe/runtime loader:** `src/plugins/pi-compat/probe.mjs`

```js
export async function probePiExtension(pluginDir) {
  const captured = { tools: [], commands: [] };
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', LOADER_HOOK_URL,
      '-e', `
        globalThis.__bahulam_pi_captured = { tools: [], commands: [] };
        const entry = ${JSON.stringify(resolvePiEntry(pluginDir))};
        import(entry).then(() => {
          process.stdout.write(JSON.stringify(globalThis.__bahulam_pi_captured));
        }).catch(err => { console.error(err.message); process.exit(1); });
      `,
    ], { env: { ...process.env, BAHULAM_PI_PLUGIN: path.basename(pluginDir) } });

    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(out)));
  });
}
```

**Why probe in a child, not the main process:** pi extensions can throw at load time, `require`-in-ESM, or do other things we don't want to inherit into the CLI process. Child isolation is a robustness win; we throw away the loaded module afterward and re-import it later via the same hook for actual invocation.

### Step 4 — `mode:` field + validator update (~0.5 day)

**File:** `src/plugins/pi-compose.mjs`

Add `mode` to `normalizeCompose`:

```js
mode: ['tools', 'sub_agent'].includes(composeDef?.mode) ? composeDef.mode : 'tools',
expose_as_agent: composeDef?.mode === 'sub_agent' ? String(composeDef?.expose_as_agent || '').trim() : null,
```

Update `validateCompose`:
- `mode: 'sub_agent'` → `expose_as_agent` required, matches agent slug regex, `expose[]` may be empty (agent handles its own tools internally)
- `mode: 'tools'` (default) → `expose[]` required, existing rules

### Step 5 — Registry loader: resolve composes at pack install (~1 day)

**File:** `src/plugins/registry.mjs`

On pack install, walk `manifest.config.composes[]`:
1. For each compose entry with `mode: 'tools'`: install pi source if not present (Step 1), run discovery (Step 2)
2. For each compose entry with `mode: 'sub_agent'`: install pi source, register a synthetic agent named `expose_as_agent` in the pack's agent list, mark with `_delegates_to: { pi_package, ... }`
3. Cross-check `verified: true` entries against `~/.bahulam/verified-pi-packages.json` (Sprint 2 registry, empty in Sprint 1)
4. Build the effective tool map: `[...(config.tools || []), ...expandComposedTools(...)]` — native tools are optional; the placeholder records from `pi-compose.mjs:116` get filled in with real handlers at execution time

### Step 6 — Tool executor integration for `mode: tools` (~1 day)

**File:** `src/core/tool-executor.mjs`

When our agent invokes `fx.add_transitions`:
1. Existing `pluginToolMap` lookup finds a placeholder with `_composed: { source, package_name, namespace, original_name }`
2. **New:** if placeholder, resolve to a real handler:
   - Check per-session cache `__pi_loaded_handlers[pluginDir]`
   - If miss: spawn a persistent child process (or reuse one per pi package) with the loader hook, do the import once, keep handlers in-process
   - Call `handler(args)`; return result through the standard `{ success, output }` shape
3. Attribution: our existing scoped executor already tags `internal + subAgent`; add `plugin: fx (composed from pi:@ffmpeg/transitions)` to the source field

**Reuse:** existing `pluginToolMap`, `executeToolWithHooks`, approval/hook gating, scoped executor. Only new code: the `_composed` → handler resolution.

**Persistent child vs re-import per call:** pi extensions may have setup cost (SDK init, config load). Persistent child amortizes it. But it complicates lifecycle (kill on plugin uninstall, memory, crash recovery). Sprint 1 recommendation: **re-import per call** (correctness first, ~50ms overhead is fine for ~seconds-scale tool calls). Sprint 2 add persistent child if profiling justifies.

### Step 6b — `mode: sub_agent` delegation (~2 days, optional in Sprint 1)

**File:** `src/plugins/pi-compat/subagent-adapter.mjs`

For rare loop-heavy pi packages. Same substrate as our existing external-agent delegation (Claude Code, Goose adapters).

```js
export async function delegatePiSubAgent({ composed, task, ctx }) {
  // Shell out to `pi` with the composed package pre-installed. Pass task via stdin.
  // Stream events into our lane display via ctx.renderEvent.
  // Capture the final handoff (last user-visible message).
  const child = spawn('pi', ['run', '--package', composed.package_name, '--json-events'], { ... });
  // ... event streaming, run_id lane tagging, handoff capture ...
  return { output: handoff, run_id, duration_s };
}
```

Registered as an agent runner in `runAgentDefinition`'s substrate map, alongside `direct` (LocalAgent) and `session` (BahulamStreamClient).

**Defer decision**: skip in Sprint 1 unless a specific Sprint 2 pack requires it. Recommendation: `mode: sub_agent` is Sprint 3 unless we discover a Sprint 2 need.

### Step 7 — Model routing verification (~0.5 day)

Pi packages using standard SDKs (`@anthropic-ai/sdk`, `openai`, `openrouter`) pick up our env vars automatically. **Verify** with three canonical packages:

- One that uses `@anthropic-ai/sdk` → confirm `ANTHROPIC_API_KEY` from our creds is used
- One that uses `openai` → confirm `OPENAI_API_KEY` / `OPENAI_BASE_URL` from our creds routes through our gateway
- One that uses `openrouter` → confirm `OPENROUTER_API_KEY` from our creds routes through our gateway

**Leakage risk to document**: pi packages with hardcoded provider URLs bypass our gateway. Add to `verified` review checklist: grep for hardcoded `.anthropic.com`, `.openai.com`, etc. Warn at install if unverified compose is detected with an SDK dep.

### Step 8 — Docs + selftest (~1 day)

**Docs:** `docs/pi-compat-authoring.md` — how to write a pack that composes pi packages, with three worked examples (namespace vs flat, verified vs unverified, `mode: sub_agent`).

**Selftest:** `test/pi-compat-smoke.mjs`
1. Install one canonical pi package (`pi:@hello/world` or similar tiny one)
2. Compose it in a test pack fixture
3. Preflight the test pack — expect success
4. Invoke a composed tool through the tool executor
5. Assert attribution shape (`_composed`, source, verified flag)
6. Assert model-routing env vars visible to the tool

## Total effort

| Step | Days | Sprint |
|---|---|---|
| 1. `pi:` install source | 1 | 1 |
| 2. Manifest reader + tool discovery cache | 1 | 1 |
| 3. Pi runtime shim | 2–3 | 1 |
| 4. `mode:` field + validator | 0.5 | 1 |
| 5. Registry loader: resolve composes | 1 | 1 |
| 6. Tool executor integration (`mode: tools`) | 1 | 1 |
| 6b. `mode: sub_agent` delegation | 2 | 3 (or Sprint 1 if needed) |
| 7. Model routing verification | 0.5 | 1 |
| 8. Docs + selftest | 1 | 1 |
| **Sprint 1 total** (default `mode: tools`) | **8–10** | 1 |
| **+ escape hatch** | **10–12** | 1 if built with |

## Reused infrastructure (nothing new to build)

- `installFromGit` / `installFromLocal` rollback machinery in `plugin-manage.mjs`
- Existing plugin registry (`registry.mjs`)
- Preflight framework and composition validation (already scaffolded in `preflight.mjs:106-124` and `pi-compose.mjs`)
- `pluginToolMap` in `tool-executor.mjs:774`
- Approval / hook gating (`executeToolWithHooks`)
- Scoped executor (`createScopedToolExecutor` in `terminal/agents.mjs`)
- Per-plugin state blackboard (`state.mjs`) — available to native pack tools; composed pi tools usually stay stateless and return data that native tools may persist when needed
- External-agent delegation substrate (for Step 6b)

## Known hard problems and mitigations

**Security inherited from pi (unchanged from pi's own posture).**
Composed pi packages run with the pack's process permissions. Mitigations:
- Verified registry (curated review, ~5 packages/week)
- `⚠ N unverified pi packages` warning at install
- `verified: true` required by default on hosted Studios (unverified needs explicit `--allow-unverified-composes` at install; off entirely for hosted)
- Hosted Studios never install pi packages locally — the composition runs in our MicroVM, blast radius contained

**Pi API drift.**
Shim pinned to a specific pi runtime version. Compat matrix in `docs/pi-compat-matrix.md`. Proactive updates when pi ships breaking changes. Same problem npm ecosystems solve daily; battle-tested tooling applies.

**Extensions that need `pi.events` cross-package coordination.**
No-op in v1 with a debug warning. If a composed extension depends on another via events, its coordination breaks. Discovery cache captures this via probe failure or empty-tool-result telemetry. Mitigation: `pi.events` bus is a Sprint 3+ item if data shows demand; alternatively, `mode: sub_agent` for those packages routes around it entirely.

**TypeScript-first pi packages.**
Some pi packages ship `.ts` entry points. Node's ESM loader can handle `.ts` via `--loader tsx` or similar. Document as a prereq for the pack, or add a `.ts` loader step to the shim setup.

## The manim-studio proof — end-to-end validation

After Steps 1–7 land, prove the composition model works end-to-end by upgrading `awesome-bahulam-plugins/plugins/manim-studio` from bare Manim into a composed video pipeline:

1. **Identify pi packages** — pick 2 real, popular pi packages that add value (e.g., `pi:@ffmpeg/transitions` for post-production, `pi:@design/thumbnail-gen` for poster art)
2. **Compose them in `manim-studio/plugin.yaml`** — add a `config.composes:` block with `verified: true` (we've reviewed them for the proof)
3. **Update the animator agent** — extend `tools:` to include the composed tool names (`fx.add_transitions`, `thumbnail.generate`)
4. **Update the system prompt** — teach the agent to call the new tools after rendering
5. **Run the demo prompt end-to-end** — verify:
   - The pi packages install via `bahulam plugin install manim-studio`
   - Preflight passes with the composed tools listed
   - The animator agent's model sees the composed tool schemas
   - Rendering + post-production + thumbnail generation all happen in one Studio run
   - Attribution in the transcript shows `plugin: fx (composed from pi:@ffmpeg/transitions)`
   - The workspace gallery view lists the composed outputs

**Success criteria:** one Studio run produces a rendered Manim video with transitions and a thumbnail, using two pi packages we didn't author, entirely inside Bahulam's runtime. This validates the whole §13.6.1 story in one demo.

## Open questions

1. **Which two pi packages for the manim proof?** Depends on what's actually in the pi registry and passes our review. Concrete task: browse `pi.dev/packages` filtered by keyword `ffmpeg` and `design`, pick two, confirm license + review checklist.
2. **Persistent child vs re-import per call for Step 6?** Sprint 1 default is re-import per call; profile and decide in Sprint 2.
3. **Verified registry seeding**: Sprint 2 targets 30–50 packages. Which 30 first? The ones used by our Sprint 2 Studios take priority; long-tail can follow demand.
4. **Do we want a `bahulam pi-search <query>` command?** Nice-to-have that queries pi.dev/packages and shows install-ability, verified status. Sprint 3 quality-of-life.
5. **Shim behavior when a pi package registers zero tools** (only commands, only widgets)? Currently discovery returns empty tools list; preflight would then reject the compose as "no tools exposed." Correct default, but may surprise authors of TUI-first pi packages.

## Cross-reference

- Master strategy: `tarang orca platform docs/PRDs/PRD-102-Unified-Deterministic-Agent-Orchestration.md` §13.6.1 (composition model), §13.6.1b (this plan, high-level), §13.6.1c (verified registry), §13.6.1d (composition scope)
- Contract layer already in code: `src/plugins/pi-compose.mjs`, `src/plugins/preflight.mjs` (composes validation)
- Reference plugin to upgrade: `awesome-bahulam-plugins/plugins/manim-studio/`
