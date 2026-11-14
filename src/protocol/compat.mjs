/** v1 remains the default for existing daemon transports during Phase 0. */
const TYPES = { tool_requested: 'tool_call', tool_finished: 'tool_result', turn_ended: 'agent_complete', agent_spawned: 'sub_agent_start', agent_finished: 'sub_agent_complete', usage_update: 'tokens_used' };
const LEGACY_EVENTS = new Set(['session_started', 'turn_started', 'turn_ended', 'thinking_delta',
  'tool_requested', 'tool_finished', 'approval_required', 'approval_decided', 'diff', 'test_result', 'usage_update']);
export function toLegacyEvent(event) {
  if (event.v !== 2) return event;
  // Old attach renderers print an unknown-type row for every frame. In
  // particular, forwarding text deltas would turn a response into token spam.
  if (!LEGACY_EVENTS.has(event.type)) return null;
  const { id, agent_id, parent_agent_id, payload_ref, ...legacy } = event;
  return { ...legacy, v: 1, type: TYPES[event.type] || event.type,
    ...(event.turn_id == null ? { turn_id: undefined } : {}),
    data: { ...event.data,
      ...(event.type === 'usage_update' ? { prompt: event.data.input_tokens, completion: event.data.output_tokens, cached: event.data.cache_tokens } : {}),
      ...(event.type === 'agent_spawned' ? { query: event.data.task, run_id: agent_id } : {}),
      ...(event.type === 'tool_requested' ? { tool: event.data.name } : {}),
      ...(payload_ref ? { output_ref: payload_ref } : {}) } };
}
