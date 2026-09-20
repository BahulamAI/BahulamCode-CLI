/**
 * Startup network work is optional and never gates local history or the prompt.
 */
import { runPreflight } from '../onboarding/preflight.mjs';

const sameIdentity = (a, b) => a.token === b.token && a.backendUrl === b.backendUrl;

/** Refresh an open terminal when another process changes shared credentials.
 * Polling reads only local config; network work runs on a change or explicit check.
 */
export function createSessionAuthSync({ auth, session, fetchProfile = fetchUserProfile }) {
  let identity = auth.loadCredentials();
  let generation = 0;
  let pending = null;
  return async function refresh({ force = false } = {}) {
    const latest = auth.loadCredentials();
    const changed = !sameIdentity(identity, latest);
    if (changed) {
      identity = latest;
      generation++;
      pending = null;
      // Do not leave the previous account's name, plan or balance on screen.
      Object.assign(session, { user: null, isByok: false, subscriptionTier: null,
        creditsTotal: null, creditsIncluded: null, creditsPurchased: null,
        creditsLimit: null, rateLimit: null, creditsLowWarned: false, msgsLowWarned: false });
    }
    if (!latest.token) { session.user = null; return null; }
    if (pending) return pending;
    if (!changed && !force) return session.user;
    const requestGeneration = generation;
    const request = (async () => {
      const user = await fetchProfile(auth);
      if (requestGeneration !== generation || !sameIdentity(latest, auth.loadCredentials())) return null;
      // A failed/offline profile check is not proof that a saved token is invalid.
      if (user) {
        session.user = user;
        if (!session.model && !session.modelOverrides?.reasoning) session.model = user.default_reasoning_model || null;
      }
      return user;
    })();
    pending = request;
    try { return await request; }
    finally { if (pending === request) pending = null; }
  };
}

export async function fetchUserProfile(auth, { timeoutMs = 2500, fetchImpl = globalThis.fetch } = {}) {
  const creds = auth.loadCredentials();
  if (!creds.token || !creds.backendUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(creds.backendUrl + '/api/user/me', {
      headers: { Authorization: 'Bearer ' + creds.token }, signal: controller.signal,
    });
    return response.ok ? await response.json() : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function refreshStartupChecks({ auth, session, cwd, version, preflight = true,
  runChecks = runPreflight, fetchProfile = fetchUserProfile }) {
  const identity = auth.loadCredentials();
  const checks = preflight
    ? await runChecks({ auth, cwd, version, silent: true })
    : [{ user: await fetchProfile(auth) }];
  // A late startup response must not undo a login/logout or a chosen model.
  if (!sameIdentity(auth.loadCredentials(), identity)) return [];
  const user = checks[0]?.user;
  if (user) {
    session.user = user;
    if (!session.model && !session.modelOverrides?.reasoning) session.model = user.default_reasoning_model || null;
  }
  return checks;
}
