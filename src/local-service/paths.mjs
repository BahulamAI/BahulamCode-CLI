/**
 * Local service paths.
 *
 * The local service is a separate product/runtime surface from the terminal
 * daemon. It owns browser-based local workspaces and document processing.
 */

import * as path from 'node:path';
import { bahulamHome } from '../core/paths.mjs';

export function localServiceRoot() {
  return path.join(bahulamHome(), 'local-service');
}

export function localServiceSessionsRoot() {
  return path.join(localServiceRoot(), 'sessions');
}

export function localServiceSessionDir(sessionId) {
  return path.join(localServiceSessionsRoot(), sessionId);
}

export function localServiceSessionPath(sessionId) {
  return path.join(localServiceSessionDir(sessionId), 'session.json');
}

export function localServiceStatePath() {
  return path.join(localServiceRoot(), 'state.json');
}
