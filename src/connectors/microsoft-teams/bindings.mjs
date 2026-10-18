import { createHash } from 'node:crypto';

export const scopeKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

// Called only after the Teams SDK has authenticated the incoming activity.
// Configuration comes from the administrator, never from chat/tool arguments.
export function resolveBinding(activity, bindings) {
  const tenant = activity.channelData?.tenant?.id;
  const actor = activity.from?.aadObjectId;
  const conversation = activity.conversation?.id;
  if (activity.channelId !== 'msteams' || !tenant || !actor || !conversation || !activity.id) {
    throw new Error('An authenticated Teams tenant, user, conversation, and activity ID are required.');
  }
  const matches = bindings.filter(binding => {
    if (binding.teams_tenant_id !== tenant || !binding.users?.[actor]) return false;
    if (activity.conversation?.conversationType === 'personal') return binding.personal === true;
    return Boolean(binding.teams_team_id && binding.teams_channel_id)
      && binding.teams_team_id === activity.channelData?.team?.id
      && binding.teams_channel_id === activity.channelData?.channel?.id;
  });
  if (matches.length !== 1) throw new Error('No unique organization/team connection is configured for you in this conversation. Contact your administrator.');
  const binding = matches[0];
  for (const key of ['bahulam_organization_id', 'organization', 'project', 'team']) {
    if (typeof binding[key] !== 'string' || !binding[key].trim()) throw new Error(`Connection is missing ${key}.`);
  }
  const user = binding.users[actor];
  if (!/^[A-Z][A-Z0-9_]*$/.test(user.pat_env || '')) throw new Error('User credential mapping is incomplete.');
  const scope = scopeKey(tenant, binding.bahulam_organization_id,
    binding.organization, binding.project, binding.team, actor);
  return { binding, user, actor, conversation, scope,
    session: scopeKey(scope, conversation), receipt: scopeKey(scope, conversation, activity.id) };
}

export function scopedState(state, resolved) {
  const { binding, actor, conversation } = resolved;
  const config = { organization: binding.organization, project: binding.project, team: binding.team,
    bahulam_organization_id: binding.bahulam_organization_id, bahulam_team_id: binding.bahulam_team_id || '',
    actor_id: actor, conversation_id: conversation,
    locked_project: binding.project, locked_team: binding.team };
  return { ...state, getConfig: key => config[key] ?? null, getAllConfig: () => {
    throw new Error('Bulk credential reads are disabled in Teams.');
  } };
}
