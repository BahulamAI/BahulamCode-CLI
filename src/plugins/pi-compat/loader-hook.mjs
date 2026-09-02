/**
 * Node ESM loader hook that intercepts `import { pi } from 'pi'` and
 * resolves it to a virtual module which re-exports our shim.
 *
 * Registered from probe.mjs via child_process spawn with:
 *   node --import ./loader-hook.mjs -e '<probe script>'
 *
 * The virtual module source is generated at load time so it can inline
 * the shim import URL (avoids brittle relative paths across cwd's).
 */

import { pathToFileURL } from 'node:url';
import { register } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_URL = pathToFileURL(path.join(HERE, 'shim.mjs')).href;
const VIRTUAL_URL = 'bahulam-pi-shim:v1';

// Register ourselves as a loader — this file is `--import`ed, and the
// register() call installs the resolve/load hooks below into a worker
// data URL. Simpler than a standalone hooks file.
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, nextResolve) {
    if (specifier === 'pi') return { shortCircuit: true, url: '${VIRTUAL_URL}' };
    return nextResolve(specifier, context);
  }
  export function load(url, context, nextLoad) {
    if (url === '${VIRTUAL_URL}') {
      return {
        shortCircuit: true,
        format: 'module',
        source: \`
          import { createPiShim } from ${JSON.stringify(SHIM_URL)};
          const captured = globalThis.__bahulam_pi_captured ||= { tools: [], commands: [] };
          const pluginName = process.env.BAHULAM_PI_PLUGIN || 'pi';
          export const pi = createPiShim({ pluginName, captured });
          export default pi;
        \`,
      };
    }
    return nextLoad(url, context);
  }
`)}`, import.meta.url);
