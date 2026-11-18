import { registerPending, resolvePending } from './approval-store.mjs';

// Presentation adapter only: ApprovalManager supplies the options and applies
// the result, including policy, trust and audit logging. No tool runs here.
// Only identity metadata crosses into presentation; tool arguments and policy stay authoritative.
const identityKeys = ['agent_id', 'sub_agent_run_id', 'subagent_id', 'sub_agent_id', 'run_id',
  'graph_run_id', 'node_id', 'sub_agent', 'parent_agent_id', 'parent_run_id', 'turn_id'];
function presentationIdentity(context = {}) {
  return Object.fromEntries(identityKeys.filter(key => typeof context[key] === 'string' && context[key])
    .map(key => [key, context[key]]));
}
const scopes = { approve: 'once', 'allow-session': 'session', 'allow-project': 'project', 'allow-type': 'type' };
export function createRustApprovalBridge({ emit }) {
  let active = null;
  let closed = false;
  let generation = 0;
  let queue = Promise.resolve();
  const finish = (value, decidedBy = 'rust-tui') => {
    if (!active) return false;
    const request = active;
    active = null;
    request.pending.cancel();
    emit('approval_decided', { ...request.identity, apr_id: request.id, decision: value === 'reject' ? 'deny' : 'approve', scope: scopes[value] || 'once', decided_by: decidedBy });
    request.resolve(value);
    return true;
  };
  return {
    choose(request) {
      const acceptedGeneration = generation;
      const run = queue.then(() => {
        if (closed || acceptedGeneration !== generation) return 'reject';
        return new Promise(resolve => {
          const options = request.options.filter(option => option.value === 'reject' || scopes[option.value]);
          const pending = registerPending({ kind: request.tool, subject: request.why });
          const id = pending.apr_id;
          const identity = presentationIdentity(request.agentContext);
          active = { id, options, resolve, pending, identity };
          // Socket/mobile/timeout decisions race the Rust keys through the same registry.
          pending.race.then(answer => {
            if (active?.id !== id) return;
            const value = answer.decision === 'approve'
              ? Object.keys(scopes).find(key => scopes[key] === (answer.scope || 'once')) : 'reject';
            finish(options.some(option => option.value === value) ? value : 'reject', answer.decided_by);
          });
          emit('approval_required', { ...identity, apr_id: id, name: request.tool, args: request.args,
            cwd: request.cwd, risk_tier: request.tier, reason: request.why,
            scopes: options.map(option => scopes[option.value]).filter(Boolean) });
        });
      });
      queue = run.catch(() => {});
      return run;
    },
    answer(type, data = {}) {
      if (!['approve', 'deny'].includes(type) || !active || data.apr_id !== active.id) return false;
      const value = type === 'deny' ? 'reject' : Object.keys(scopes).find(key => scopes[key] === (data.scope || 'once'));
      if (!active.options.some(option => option.value === value)) return false;
      return resolvePending(type, active.id, 'rust-tui', '', data.scope || 'once');
    },
    cancel() { generation++; return finish('reject'); },
    close() { closed = true; finish('reject'); },
  };
}
