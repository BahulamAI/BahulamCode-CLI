/**
 * Startup network work is optional and never gates local history or the prompt.
 */
import { runPreflight } from '../onboarding/preflight.mjs';

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
  const token = auth.loadCredentials().token;
  const checks = preflight
    ? await runChecks({ auth, cwd, version, silent: true })
    : [{ user: await fetchProfile(auth) }];
  // A late startup response must not undo a login/logout or a chosen model.
  if (auth.loadCredentials().token !== token) return [];
  const user = checks[0]?.user;
  if (user) {
    session.user = user;
    if (!session.model && !session.modelOverrides?.reasoning) session.model = user.default_reasoning_model || null;
  }
  return checks;
}
