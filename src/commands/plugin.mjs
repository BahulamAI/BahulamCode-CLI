/**
 * Plugin CLI Commands — open a workspace with a named plugin loaded.
 *
 * Commands:
 *   bahulam-code plugin <name> [path]    Open workspace with plugin tools
 *
 * The named plugin is looked up in the standard plugin directories,
 * verified to exist, then a local workspace is started at [path]
 * (or the current directory) with the plugin's tools, handlers,
 * and optionally sub-agents available.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createLocalWorkspaceSession,
  listLocalWorkspaceSessions,
  loadLocalWorkspaceSession,
  writeLocalWorkspaceSession,
} from '../local-service/session-store.mjs';
import { startLocalWorkspaceService } from '../local-service/server.mjs';
import { openLocalBrowser } from '../local-service/browser.mjs';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

/**
 * Standard directories to search for plugins.
 */
const PLUGIN_SEARCH_DIRS = [
  path.join(process.cwd(), '.bahulam', 'plugins'),
  path.join(os.homedir(), '.bahulam', 'plugins'),
];

/**
 * Find a plugin directory by name across all standard search paths.
 * Returns the directory path and manifests on success, null on miss.
 */
function findPluginDir(name) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return null;

  for (const searchDir of PLUGIN_SEARCH_DIRS) {
    try {
      if (!fs.existsSync(searchDir)) continue;
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(searchDir, entry.name);
        // Check both plugin.yaml and plugin.json
        const yamlPath = path.join(pluginDir, 'plugin.yaml');
        const jsonPath = path.join(pluginDir, 'plugin.json');
        let manifestPath = null;
        if (fs.existsSync(yamlPath)) manifestPath = yamlPath;
        else if (fs.existsSync(jsonPath)) manifestPath = jsonPath;

        if (!manifestPath) continue;

        // Quick name match — match against directory name first (fast path),
        // then parse the manifest for its metadata.name if needed
        if (entry.name.toLowerCase() === needle) {
          return { dir: pluginDir, manifestPath, searchDir };
        }

        // Parse manifest to check metadata.name
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        let manifest;
        try {
          manifest = JSON.parse(raw);
        } catch {
          // Might be YAML — try simple YAML top-level name extraction
          // For speed, check for `name:` line patterns
          const nameMatch = raw.match(/^(?:name|metadata\.name|metadata:\s*\n\s+name)\s*:\s*(.+)$/m);
          if (nameMatch) {
            const metaName = nameMatch[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
            if (metaName === needle) {
              return { dir: pluginDir, manifestPath, searchDir };
            }
          }
          continue;
        }

        const metaName = (
          manifest?.metadata?.name ||
          manifest?.name ||
          ''
        ).toLowerCase();
        if (metaName === needle) {
          return { dir: pluginDir, manifestPath, searchDir };
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }
  return null;
}

/**
 * Main entry point for `bahulam-code plugin` subcommand.
 * @param {object} args - parsed CLI args
 * @param {object} [options]
 * @param {string} [options.cwd]
 */
export async function handlePluginCommand(args, { cwd = process.cwd() } = {}) {
  const pluginName = String(args.pluginName || '').trim();
  const targetPath = String(args.targetPath || cwd).trim();

  if (!pluginName || args.help) {
    printPluginUsage();
    process.exit(args.help ? 0 : 1);
  }

  // 1. Find the plugin
  const found = findPluginDir(pluginName);
  if (!found) {
    process.stderr.write(
      `${RED}✗ Plugin "${pluginName}" not found.${RESET}\n` +
      `  ${DIM}Searched:${RESET}\n` +
      PLUGIN_SEARCH_DIRS.map(d => `    ${d}`).join('\n') + '\n' +
      `  ${DIM}Create a plugin.yaml or plugin.json in one of these directories.${RESET}\n`
    );
    process.exit(1);
  }

  // 2. Verify the target path exists
  let resolvedPath;
  try {
    resolvedPath = path.resolve(cwd, targetPath);
    if (!fs.existsSync(resolvedPath)) {
      process.stderr.write(
        `${RED}✗ Target path does not exist: ${resolvedPath}${RESET}\n`
      );
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(
      `${RED}✗ Invalid target path: ${err.message}${RESET}\n`
    );
    process.exit(1);
  }

  // 3. Create a local workspace session with plugin context
  const sessionTitle = `${pluginName} plugin — ${path.basename(resolvedPath) || resolvedPath}`;
  const { session, token } = createLocalWorkspaceSession({
    targetPath: resolvedPath,
    cwd,
    kind: `plugin-${pluginName}`,
    title: sessionTitle,
  });

  // Augment session with plugin metadata so the workspace knows which
  // plugin to highlight
  const stored = loadLocalWorkspaceSession(session.id);
  if (stored) {
    stored.plugin = {
      name: pluginName,
      plugin_dir: found.dir,
      manifest_path: found.manifestPath,
    };
    writeLocalWorkspaceSession(stored);
    session.plugin = stored.plugin;
  }

  // 4. Start the workspace service
  const service = await startLocalWorkspaceService({
    session,
    token,
    port: args.port || 0,
  });

  // 5. Output
  const url = typeof service === 'object' ? service.url : '';
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, session, plugin: pluginName, url, port: service.port }, null, 2)}\n`
    );
  } else {
    process.stderr.write(`\n${BOLD}${CYAN}Bahulam Plugin Workspace${RESET}\n`);
    process.stderr.write(`  ${DIM}plugin${RESET}    ${pluginName}\n`);
    process.stderr.write(`  ${DIM}session${RESET}  ${session.id}\n`);
    process.stderr.write(`  ${DIM}root${RESET}     ${session.root_path}\n`);
    process.stderr.write(`  ${DIM}url${RESET}      ${CYAN}${url}${RESET}\n\n`);
    process.stderr.write(
      `${GREEN}ready${RESET} ${DIM}Plugin workspace started at 127.0.0.1:${service.port}. Press Ctrl+C to stop.${RESET}\n`
    );
  }

  if (args.open !== false) {
    openLocalBrowser(url);
  }

  // 6. Wait for shutdown
  await new Promise((resolve) => {
    let done = false;
    const stop = async () => {
      if (done) return;
      done = true;
      await service.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function printPluginUsage() {
  process.stderr.write(
    `${BOLD}PLUGIN COMMANDS${RESET}\n` +
    `  ${CYAN}bahulam-code plugin <name> [path]${RESET}   ` +
    `Open a workspace with a named plugin loaded\n` +
    `\n` +
    `  ${DIM}<name>${RESET}  Plugin name (directory name or metadata.name in plugin.yaml)\n` +
    `  ${DIM}[path]${RESET}  Target workspace directory (default: current directory)\n` +
    `\n` +
    `  ${DIM}Options:${RESET}\n` +
    `    --port <n>      Bind a specific localhost port\n` +
    `    --no-open       Start service without opening the browser\n` +
    `    --json          Print session JSON and do not open the browser\n` +
    `\n` +
    `  ${DIM}Search paths:${RESET}\n` +
    PLUGIN_SEARCH_DIRS.map(d => `    ${d}`).join('\n') + '\n' +
    `\n` +
    `  ${DIM}Example:${RESET}\n` +
    `    bahulam-code plugin seo-manager ~/projects/client-site\n`
  );
}
