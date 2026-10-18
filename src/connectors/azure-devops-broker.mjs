/** Host transport for PRD-117. Run in the trusted host, not the plugin worker. */
export const ADO_REVIEW_OPERATIONS = Object.freeze([
  'ado_get_pull_request', 'ado_list_pull_request_changes', 'ado_list_pull_request_threads',
  'ado_list_pull_request_iterations', 'ado_get_pull_request_file',
  'ado_propose_review_comment', 'ado_publish_review_comment',
]);

export function createAdoBrokerTransport({ brokerUrl, getInvocationAuthorization, fetchImpl = globalThis.fetch }) {
  const base = new URL(brokerUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('An HTTPS broker URL without embedded credentials is required.');
  }
  return async ({ connectionId, operation, args, signal }) => {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId) || !ADO_REVIEW_OPERATIONS.includes(operation)) {
      throw new Error('ADO operation denied.');
    }
    // The trusted dispatcher derives identity/session/plugin digest from its
    // verified invocation. The plugin must never supply these authorizations.
    const auth = await getInvocationAuthorization({ connectionId, operation });
    if (!auth?.identityToken || !auth?.scopeToken) throw new Error('ADO runtime authorization is missing.');
    let response;
    try {
      response = await fetchImpl(new URL(`${connectionId}/execute/`, base.href.replace(/\/?$/, '/')), {
        method: 'POST', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
        headers: { 'Content-Type': 'application/json', 'X-Bahulam-Identity': auth.identityToken, 'X-Bahulam-Scope': auth.scopeToken,
          ...(auth.runId ? { 'X-Bahulam-Run': auth.runId } : {}) },
        body: JSON.stringify({ operation, arguments: args }),
      });
    } catch { throw new Error('ADO broker unavailable; check approval status before retrying a write.'); }
    if (!response.ok) throw new Error('ADO operation denied or connection unavailable. Check connection and approval status.');
    let payload;
    try { payload = await response.json(); } catch { throw new Error('Invalid ADO broker response.'); }
    return payload.result;
  };
}

/** Serialize config across the worker boundary; wire invoke through scoped RPC.
 * Never pass the host transport/getInvocationAuthorization object to a worker.
 */
export function createBrokeredAdoConnection({ connectionId, invoke }) {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId) || typeof invoke !== 'function') throw new Error('ADO connection binding required.');
  return Object.freeze({
    config: Object.freeze({ provider: 'azure-devops', auth_mode: 'oauth2', connection_id: connectionId }),
    async execute(operation, args, { signal } = {}) {
      if (!ADO_REVIEW_OPERATIONS.includes(operation)) throw new Error('ADO operation denied.');
      return invoke({ connectionId, operation, args, signal });
    },
  });
}
