/** Bahulam-owned ADO connection. The plugin receives config + request(), never a PAT. */
export function createAzureDevOpsConnection({ organization, project, team, pat, fetchImpl = globalThis.fetch }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(organization || '') || !project || !team || !pat) {
    throw new Error('An ADO organization, project, team and user credential are required.');
  }
  const auth = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  const config = Object.freeze({ organization, project, team, locked_project: project, locked_team: team });
  return Object.freeze({ config, async request({ method = 'GET', path, body, contentType = 'application/json', apiVersion = '7.1', signal }) {
    const p = encodeURIComponent(project);
    const t = encodeURIComponent(team);
    // A plugin cannot turn the caller's credential into an arbitrary URL fetch
    // or select another project/team. Team is a routing default, not an ADO ACL.
    const relative = String(path || '');
    const pathOnly = relative.split('?')[0];
    const segments = pathOnly.split('/').map(part => decodeURIComponent(part));
    if (segments.some(part => part === '.' || part === '..' || part.includes('/') || part.includes('\\'))
      || relative.includes('#') || !['GET', 'POST', 'PATCH'].includes(method)) throw new Error('Connection request is outside its allowed scope.');
    const projectApi = pathOnly.startsWith(`${p}/_apis/`);
    const teamApi = pathOnly.startsWith(`${p}/${t}/_apis/work/`);
    const discovery = pathOnly === `_apis/projects/${p}` || pathOnly === `_apis/projects/${p}/teams/${t}`
      || pathOnly === `_apis/projects/${p}/teams/${t}/members`;
    if (!projectApi && !teamApi && !(discovery && method === 'GET')) throw new Error('Connection request is outside its mapped project/team.');
    if (Array.isArray(body) && body.some(op => String(op.path).toLowerCase() === '/fields/system.teamproject')) {
      throw new Error('Cross-project work item moves are not allowed.');
    }
    const url = new URL(`https://dev.azure.com/${encodeURIComponent(organization)}/${relative}`);
    url.searchParams.set('api-version', apiVersion);
    const timeout = AbortSignal.timeout(30000);
    let response;
    try {
      response = await fetchImpl(url.href, { method, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Authorization: auth, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': contentType }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new Error('ADO connection failed or timed out. A write may already have been applied; check before retrying.'); }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { throw new Error('ADO returned a non-JSON response.'); }
    if (!response.ok) {
      const message = String(data?.message || `HTTP ${response.status}`).split(pat).join('[redacted]').split(auth).join('[redacted]');
      throw new Error(`ADO request failed: ${message}`);
    }
    const continuation = response.headers?.get('x-ms-continuationtoken');
    if (continuation && data && typeof data === 'object') data.continuation_token = continuation;
    return data;
  } });
}
