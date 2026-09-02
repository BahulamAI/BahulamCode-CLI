/**
 * Pi composition helpers.
 *
 * This is the contract layer for PRD-102 §13.6.1b. It deliberately does
 * not install or execute pi packages yet; it gives manifest/preflight/
 * registry code one normalized shape to test against.
 */

export const PI_TOOLS_CACHE = '.bahulam-tools.json';

const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const NAMESPACE_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

export function parsePiSource(source) {
  const raw = String(source || '').trim();
  if (!raw.startsWith('pi:')) return null;
  const spec = raw.slice(3).trim();
  if (!spec) return null;

  let packageName = spec;
  let versionRange = '';
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    const versionAt = slash >= 0 ? spec.indexOf('@', slash + 1) : -1;
    if (versionAt > 0) {
      packageName = spec.slice(0, versionAt);
      versionRange = spec.slice(versionAt + 1);
    }
  } else {
    const versionAt = spec.lastIndexOf('@');
    if (versionAt > 0) {
      packageName = spec.slice(0, versionAt);
      versionRange = spec.slice(versionAt + 1);
    }
  }

  if (!NPM_NAME_RE.test(packageName)) return null;
  return {
    kind: 'pi',
    source: raw,
    spec,
    package_name: packageName,
    packageName,
    version_range: versionRange || null,
    versionRange: versionRange || null,
  };
}

export function normalizeCompose(composeDef, index = 0) {
  const source = String(composeDef?.source || '').trim();
  const parsed = parsePiSource(source);
  const expose = Array.isArray(composeDef?.expose)
    ? composeDef.expose.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  const namespace = String(composeDef?.as || '').trim();

  return {
    source,
    as: namespace || '',
    expose,
    verified: composeDef?.verified === true,
    package_name: parsed?.package_name || '',
    packageName: parsed?.packageName || '',
    version_range: parsed?.version_range || null,
    versionRange: parsed?.versionRange || null,
    _index: index,
    _kind: 'pi',
  };
}

export function normalizeComposes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => normalizeCompose(item, index))
    .filter(item => item.source || item.expose.length || item.as);
}

// Anthropic's tool-name regex (`^[a-zA-Z0-9_-]{1,64}$`) forbids dots, and
// the backend's client-tool sanitizer enforces the same shape. `__` is the
// convention Claude Code and MCP both use for namespaced tool names, so
// stay compatible: `namespace__tool`.
export const COMPOSED_TOOL_SEPARATOR = '__';

export function composedToolName(compose, exposedName) {
  const name = String(exposedName || '').trim();
  return compose?.as ? `${compose.as}${COMPOSED_TOOL_SEPARATOR}${name}` : name;
}

export function validateCompose(compose) {
  const errors = [];
  const warnings = [];
  const label = `Compose #${Number.isInteger(compose?._index) ? compose._index : '?'}`;

  if (!parsePiSource(compose?.source)) {
    errors.push(`${label}: source must be a pi npm spec, for example pi:@scope/package@^1.0.0`);
  }
  if (compose?.as && !NAMESPACE_RE.test(compose.as)) {
    errors.push(`${label}: as "${compose.as}" must match ${NAMESPACE_RE}`);
  }
  if (!Array.isArray(compose?.expose) || compose.expose.length === 0) {
    errors.push(`${label}: expose must list at least one pi tool`);
  } else {
    const seen = new Set();
    for (const exposed of compose.expose) {
      if (!TOOL_NAME_RE.test(exposed)) {
        errors.push(`${label}: expose "${exposed}" must match ${TOOL_NAME_RE}`);
      }
      if (seen.has(exposed)) {
        errors.push(`${label}: duplicate exposed tool "${exposed}"`);
      }
      seen.add(exposed);
    }
  }
  if (compose?.verified !== true) {
    warnings.push(`${label}: ${compose?.source || 'pi package'} is unverified; hosted Studios require verified pi packages`);
  }

  return { errors, warnings };
}

export function expandComposedTools(pluginName, pluginDir, composes = []) {
  const tools = [];
  for (const compose of composes || []) {
    for (const exposedName of compose.expose || []) {
      tools.push({
        name: composedToolName(compose, exposedName),
        description: `Composed pi tool ${exposedName} from ${compose.source}`,
        input_schema: { type: 'object', properties: {} },
        tool: '',
        plugin_name: pluginName,
        _plugin_name: pluginName,
        _plugin_dir: pluginDir,
        _composed: {
          kind: 'pi',
          source: compose.source,
          package_name: compose.package_name,
          version_range: compose.version_range,
          namespace: compose.as || null,
          original_name: exposedName,
          verified: compose.verified === true,
        },
      });
    }
  }
  return tools;
}
