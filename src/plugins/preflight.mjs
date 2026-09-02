/**
 * Plugin preflight — hard install-time validation.
 *
 * Runs on every install (and available as `bahulam plugin validate <path>`).
 * Rejects a plugin with clear per-issue errors BEFORE the installer marks
 * the install successful. The installer rolls back on any hard error.
 *
 * Checks:
 *   1. Manifest schema  — apiVersion, metadata.name/version, structure
 *   2. Tool names       — regex, length, no shadowing built-ins, no dupes
 *   3. Tool handlers    — file exists, imports cleanly, exports `call`
 *   4. Tool schemas     — parameters is a valid JSON-Schema object
 *   5. Sub-agents       — slug regex, tool references resolve to real tools
 *   6. Workspace views  — source file exists, path stays inside plugin dir
 *   7. Collisions       — name doesn't match an already-installed plugin
 *
 * Soft warnings (don't block install) surface as `warnings[]`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePluginManifestFile, validatePluginManifest } from './manifest.mjs';
import { composedToolName, validateCompose } from './pi-compose.mjs';

const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const AGENT_SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

// Names the built-in CLI toolMap owns. Plugin tools that shadow these
// are dropped silently at schema-registration time (backend
// sanitize_client_tools), so we reject upfront with a clear error.
export const RESERVED_TOOL_NAMES = new Set([
  // read
  'read_file', 'read_files', 'read_batch', 'read_attachment', 'search_code',
  'search_files', 'grep', 'list_files', 'analyze_code', 'get_file_info',
  'get_project_overview', 'git_status', 'git_diff', 'validate_file',
  'validate_structure', 'validate_build', 'lint_check', 'run_tests',
  // write
  'write_file', 'write_project', 'edit_file', 'delete_file', 'shell',
  'analyze_image', 'generate_image',
  // agent/skill/workflow admin
  'ask_user', 'agent_create', 'agent_sync', 'agents_list',
  'skill_install', 'skill_update', 'skill_remove', 'skill_view', 'skills_list',
  'workflow_create_multi', 'workflow_sync_multi', 'workflow_run_multi', 'workflow_list',
  // meta-tools reserved by the framework
  'explore', 'plan', 'verify', 'debug', 'refactor', 'advise', 'delegate',
  'bahulam_info', 'remember', 'web_search', 'web_fetch',
]);

/**
 * Preflight a plugin at `pluginDir`.
 * @param {string} pluginDir  absolute path to the plugin directory
 * @param {object} [opts]
 * @param {Function} [opts.existingPluginNames]  () => Iterable<string>
 *        used to detect collisions with already-installed plugins
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], manifest:object|null}>}
 */
export async function preflightPlugin(pluginDir, opts = {}) {
  const errors = [];
  const warnings = [];

  const yamlPath = path.join(pluginDir, 'plugin.yaml');
  const jsonPath = path.join(pluginDir, 'plugin.json');
  const manifestPath = fs.existsSync(yamlPath) ? yamlPath
    : fs.existsSync(jsonPath) ? jsonPath : null;
  if (!manifestPath) {
    return { ok: false, errors: [`No plugin.yaml or plugin.json in ${pluginDir}`], warnings, manifest: null };
  }

  const manifest = parsePluginManifestFile(manifestPath);
  if (!manifest) {
    return { ok: false, errors: [`Failed to parse manifest ${manifestPath}`], warnings, manifest: null };
  }

  // 1. Manifest schema
  const schema = validatePluginManifest(manifest);
  if (!schema.valid) errors.push(...schema.errors);

  const name = manifest.metadata?.name || '';
  if (name && !/^[a-z][a-z0-9-]{1,63}$/.test(name.toLowerCase())) {
    warnings.push(`metadata.name "${name}" should be lowercase kebab-case for registry compatibility`);
  }

  const tools = manifest.spec?.tools || [];
  const agents = manifest.spec?.agents || [];
  const views = manifest.spec?.workspace?.views || [];
  const mcpServers = manifest.spec?.mcpServers || {};
  const mcpServerNames = new Set(Object.keys(mcpServers));
  const composes = manifest.spec?.composes || [];

  // MCP server sanity — every server should have EITHER command (stdio)
  // OR url (remote). Anything else is meaningless config.
  for (const [name, cfg] of Object.entries(mcpServers)) {
    if (!cfg.command && !cfg.url) {
      errors.push(`MCP server "${name}": needs either "command" (stdio) or "url" (remote)`);
    }
    if (cfg.command && cfg.url) {
      warnings.push(`MCP server "${name}": has both command and url — command wins, url is ignored`);
    }
    if (cfg.args && !Array.isArray(cfg.args)) {
      errors.push(`MCP server "${name}": args must be an array`);
    }
  }

  // Pi composition sanity. Composed tools become part of the agent-visible
  // tool namespace, but they are not local files and are not imported here.
  const composedToolNames = new Set();
  for (const compose of composes) {
    const validated = validateCompose(compose);
    errors.push(...validated.errors);
    warnings.push(...validated.warnings);
    if (compose.as && mcpServerNames.has(compose.as)) {
      errors.push(`Compose #${compose._index}: namespace "${compose.as}" collides with an MCP server name`);
    }
    for (const exposedName of compose.expose || []) {
      const fullName = composedToolName(compose, exposedName);
      if (composedToolNames.has(fullName)) errors.push(`Composed tool "${fullName}": duplicate name`);
      if (RESERVED_TOOL_NAMES.has(fullName)) {
        errors.push(`Composed tool "${fullName}": shadows a built-in tool`);
      }
      composedToolNames.add(fullName);
    }
  }

  // 2 + 3 + 4. Tool checks
  const toolNames = new Set();
  for (const [i, tool] of tools.entries()) {
    const t = tool.name || `<tool #${i}>`;
    if (!tool.name) { errors.push(`Tool #${i}: missing name`); continue; }
    if (!TOOL_NAME_RE.test(tool.name)) {
      errors.push(`Tool "${t}": name must match ${TOOL_NAME_RE} (letters, digits, _, -; ≤64 chars)`);
    }
    if (toolNames.has(tool.name)) errors.push(`Tool "${t}": duplicate name`);
    toolNames.add(tool.name);
    if (RESERVED_TOOL_NAMES.has(tool.name)) {
      errors.push(`Tool "${t}": shadows a built-in tool — pick a different name (built-ins always win)`);
    }
    if (composedToolNames.has(tool.name)) {
      errors.push(`Tool "${t}": collides with a composed pi tool`);
    }
    if (!tool.description || tool.description.length < 8) {
      warnings.push(`Tool "${t}": description is missing or very short (<8 chars) — the model uses this to decide when to call it`);
    }
    if (!tool.tool) { errors.push(`Tool "${t}": missing tool module path (tool: ./tools/<name>.mjs)`); continue; }

    const toolModulePath = path.resolve(pluginDir, tool.tool);
    // Traversal guard
    const inside = toolModulePath === pluginDir || toolModulePath.startsWith(pluginDir + path.sep);
    if (!inside) errors.push(`Tool "${t}": tool module path escapes the plugin directory`);
    else if (!fs.existsSync(toolModulePath)) errors.push(`Tool "${t}": tool module not found: ${tool.tool}`);
    else {
      try {
        // Cache-bust because a previous install may have imported an older
        // copy at the same path in this process.
        const mod = await import(`${pathToFileURL(toolModulePath).href}?preflight=${Date.now()}`);
        if (typeof mod.call !== 'function') {
          errors.push(`Tool "${t}": tool module ${tool.tool} does not export an async \`call\` function`);
        }
      } catch (err) {
        errors.push(`Tool "${t}": tool module ${tool.tool} failed to import: ${err.message}`);
      }
    }

    // JSON-Schema shape (very light — reject non-objects, missing type: object)
    const params = tool.input_schema || tool.parameters;
    if (params && typeof params !== 'object') {
      errors.push(`Tool "${t}": parameters/input_schema must be an object`);
    } else if (params && params.type && params.type !== 'object') {
      warnings.push(`Tool "${t}": parameters.type should be "object" for tool_use compatibility`);
    }
  }

  // 5. Sub-agent checks
  const agentSlugs = new Set();
  for (const [i, agent] of agents.entries()) {
    const slug = agent.slug || agent.name || `<agent #${i}>`;
    if (!agent.slug && !agent.name) { errors.push(`Agent #${i}: missing slug or name`); continue; }
    if (agent.slug && !AGENT_SLUG_RE.test(agent.slug)) {
      errors.push(`Agent "${slug}": slug must match ${AGENT_SLUG_RE} (lowercase kebab, ≤64 chars)`);
    }
    if (agentSlugs.has(slug)) errors.push(`Agent "${slug}": duplicate slug`);
    agentSlugs.add(slug);
    if (!agent.system_prompt) warnings.push(`Agent "${slug}": missing system_prompt`);

    for (const toolRef of (agent.tools || [])) {
      if (typeof toolRef !== 'string' || !toolRef.trim()) continue;
      // MCP tools appear as `<server>.<tool>`. We can't spawn the
      // server at preflight time (would need network/subprocess), so
      // we only check that the <server> half is declared under this
      // plugin's mcpServers. The <tool> half is discovered live.
      if (toolRef.includes('.')) {
        const serverName = toolRef.split('.', 1)[0];
        if (!mcpServerNames.has(serverName) && !composedToolNames.has(toolRef)) {
          errors.push(`Agent "${slug}": tool "${toolRef}" references MCP server "${serverName}" which is not declared in mcpServers`);
        }
        continue;
      }
      if (!toolNames.has(toolRef) && !composedToolNames.has(toolRef) && !RESERVED_TOOL_NAMES.has(toolRef)) {
        errors.push(`Agent "${slug}": tool "${toolRef}" is not defined by this plugin and is not a built-in`);
      }
    }
  }

  // 6. Workspace views
  const viewNames = new Set();
  for (const [i, view] of views.entries()) {
    const label = view.name || `<view #${i}>`;
    if (viewNames.has(label)) warnings.push(`View "${label}": duplicate name — tabs will collide`);
    viewNames.add(label);
    const source = String(view.source || '').trim();
    if (!source) { errors.push(`View "${label}": missing source`); continue; }
    const abs = path.resolve(pluginDir, source);
    const inside = abs === pluginDir || abs.startsWith(pluginDir + path.sep);
    if (!inside) errors.push(`View "${label}": source path escapes the plugin directory`);
    else if (!fs.existsSync(abs)) errors.push(`View "${label}": source file not found: ${source}`);
    else if (!/\.(html?|htm)$/i.test(source)) warnings.push(`View "${label}": source should be an .html file`);
  }

  // 7. Install collision
  const existing = new Set(
    Array.from(opts.existingPluginNames?.() || [])
      .map(n => String(n || '').toLowerCase())
  );
  existing.delete(name.toLowerCase()); // reinstall of the same plugin is fine
  if (existing.has(name.toLowerCase())) {
    errors.push(`A different plugin already claims the name "${name}" (use --force to overwrite)`);
  }

  return { ok: errors.length === 0, errors, warnings, manifest };
}

/**
 * Convenience — collect installed plugin names from both search paths.
 * Used by the installer to detect collisions.
 */
export function existingInstalledNames(cwd = process.cwd()) {
  const names = [];
  for (const dir of [
    path.join(cwd, '.bahulam', 'plugins'),
    path.join(os.homedir(), '.bahulam', 'plugins'),
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.endsWith('.disabled')) continue;
      const m = parsePluginManifestFile(path.join(dir, entry.name, 'plugin.yaml'))
             || parsePluginManifestFile(path.join(dir, entry.name, 'plugin.json'));
      if (m?.metadata?.name) names.push(m.metadata.name);
    }
  }
  return names;
}
