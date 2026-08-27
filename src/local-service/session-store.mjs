/**
 * Local workspace session store.
 *
 * A local service session grants one local directory to the browser shell and
 * to the remote-agent bridge. If the user opens a single file, the grant root
 * is the file's parent and focus_path records the selected file.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  localServiceSessionDir,
  localServiceSessionPath,
  localServiceSessionsRoot,
} from './paths.mjs';
import { getLocalMachineIdentity } from './machine.mjs';

const SESSION_PREFIX = 'lws';

export function createLocalAccessToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashLocalAccessToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function verifyLocalAccessToken(session, token) {
  if (!session?.token_hash || !token) return false;
  const expected = Buffer.from(session.token_hash, 'hex');
  const actual = Buffer.from(hashLocalAccessToken(token), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function createLocalWorkspaceSession({
  targetPath = process.cwd(),
  cwd = process.cwd(),
  kind = null,
  title = null,
  token = createLocalAccessToken(),
} = {}) {
  const grant = resolveGrant(targetPath, cwd);
  const machine = getLocalMachineIdentity();
  const now = new Date().toISOString();
  const session = {
    id: createSessionId(),
    product: 'bahulam-local-service',
    machine_id: machine.id,
    machine_hostname: machine.hostname,
    kind: kind || inferSessionKind(grant),
    title: title || defaultSessionTitle(grant),
    status: 'active',
    root_path: grant.rootPath,
    focus_path: grant.focusPath,
    resource_type: grant.resourceType,
    capabilities: inferCapabilities(grant),
    created_at: now,
    updated_at: now,
    token_hash: hashLocalAccessToken(token),
    remote_bridge: {
      status: 'cli_relay',
      contract: 'browser -> local-service -> cli-authenticated remote agent -> local tools',
    },
  };

  writeLocalWorkspaceSession(session);
  return { session: publicSession(session), token };
}

export function writeLocalWorkspaceSession(session) {
  if (!session?.id) throw new Error('session.id is required');
  const dir = localServiceSessionDir(session.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(localServiceSessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function loadLocalWorkspaceSession(sessionId) {
  if (!sessionId) return null;
  const file = localServiceSessionPath(sessionId);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function listLocalWorkspaceSessions({ limit = 20 } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(localServiceSessionsRoot());
  } catch {
    return [];
  }

  return names
    .map((name) => loadLocalWorkspaceSession(name))
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, limit)
    .map(publicSession);
}

export function touchLocalWorkspaceSession(sessionId, patch = {}) {
  const session = loadLocalWorkspaceSession(sessionId);
  if (!session) return null;
  const updated = {
    ...session,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  writeLocalWorkspaceSession(updated);
  return publicSession(updated);
}

export function publicSession(session) {
  if (!session) return null;
  const { token_hash, ...safe } = session;
  return safe;
}

export function resolveGrant(inputPath, cwd = process.cwd()) {
  const resolved = expandPath(inputPath || cwd, cwd);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  if (stat.isDirectory()) {
    return {
      rootPath: fs.realpathSync(resolved),
      focusPath: '',
      resourceType: 'directory',
    };
  }

  if (stat.isFile()) {
    const parent = fs.realpathSync(path.dirname(resolved));
    return {
      rootPath: parent,
      focusPath: path.basename(resolved),
      resourceType: 'file',
    };
  }

  throw new Error(`Path is not a file or directory: ${resolved}`);
}

export function expandPath(inputPath, cwd = process.cwd()) {
  let value = String(inputPath || '').trim();
  if (!value) value = cwd;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value)) value = path.resolve(cwd, value);
  return path.normalize(value);
}

function createSessionId() {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(5).toString('hex');
  return `${SESSION_PREFIX}_${stamp}_${rand}`;
}

function defaultSessionTitle(grant) {
  if (grant.focusPath) return grant.focusPath;
  return path.basename(grant.rootPath) || grant.rootPath;
}

function inferSessionKind(grant) {
  if (grant.resourceType === 'file' && isDocumentLike(grant.focusPath)) return 'documents';
  if (looksLikeCodeWorkspace(grant.rootPath)) return 'coding';
  return 'workspace';
}

function inferCapabilities(grant) {
  const caps = new Set([
    'local_files',
    'local_shell',
    'browser_workspace',
    'remote_agent_bridge',
  ]);
  if (grant.resourceType === 'file' && isDocumentLike(grant.focusPath)) caps.add('documents');
  if (looksLikeCodeWorkspace(grant.rootPath)) caps.add('coding');
  return [...caps];
}

function isDocumentLike(fileName) {
  return /\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|rtf|odt|ods)$/i.test(String(fileName || ''));
}

function looksLikeCodeWorkspace(rootPath) {
  const markers = [
    '.git',
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'Makefile',
    'Dockerfile',
    'AGENTS.md',
    'CLAUDE.md',
    'BAHULAM.md',
  ];
  return markers.some((marker) => {
    try {
      return fs.existsSync(path.join(rootPath, marker));
    } catch {
      return false;
    }
  });
}
