import { mergeResumeReplayItems } from '../terminal/repl-format.mjs';
// Preserve the accepted resume replay, then include messages added in either view.
export function rustTranscriptItems(session) {
  const prefix = session.rustSnapshotItems || [];
  const offset = session.rustSnapshotItems ? session.rustSnapshotHistoryLength || 0 : 0;
  return [...prefix, ...(session.history || []).slice(offset).map(item => ({
    kind: 'message', role: item?.role || 'assistant', content: item?.content ?? item?.text ?? '',
  }))];
}

// Canonical messages are authoritative; replay supplies tool/agent activity.
// Sparse event logs must never hide a saved reply or replay /resume into itself.
export function rustResumeItems(users, replay, history) {
  const text = value => typeof value === 'string' ? value : Array.isArray(value)
    ? value.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
  const main = event => {
    const data = event.data || {};
    return !data.internal && !data.sub_agent && !data.run_id && !data.sub_agent_run_id
      && (!data.agent_id || data.agent_id === 'main') && (!event.agent_id || event.agent_id === 'main');
  };
  const groups = [[]];
  for (const item of mergeResumeReplayItems(users, replay, history.filter(message => message.role === 'assistant'))) {
    if (item.kind === 'user' && groups.at(-1).length) groups.push([]);
    groups.at(-1).push(item);
  }
  const output = [];
  for (const group of groups) {
    const replies = group.filter(item => item.kind === 'history').map(item => text(item.message.content));
    const prompts = new Set(group.filter(item => item.kind === 'user').map(item => text(item.message.content)));
    const remove = new Set();
    let run = [], chunks = '';
    const flush = () => {
      if (chunks && replies.some(reply => reply.startsWith(chunks))) run.forEach(item => remove.add(item));
      run = []; chunks = '';
    };
    for (const item of group) {
      if (item.kind !== 'event') continue;
      const event = item.event.event || {}, data = event.data || {};
      if (['content_partial', 'text_delta'].includes(event.type) && main(event)) {
        run.push(item); chunks += text(data.chunk ?? data.text);
      } else if (['content', 'message_end', 'turn_started', 'complete', 'turn_ended'].includes(event.type)) flush();
      if (event.type === 'command_result' && /^\/?(?:resume|tui)(?:\s|$)/i.test(data.name || '')) remove.add(item);
      if (event.type === 'turn_started' && prompts.has(text(data.text))) remove.add(item);
      if (['content', 'message_end'].includes(event.type) && main(event) && replies.some(reply => {
        const value = text(data.text ?? data.content);
        const full = value.endsWith('\n[...truncated...]') ? value.slice(0, -'\n[...truncated...]'.length) : value;
        return full && reply.includes(full);
      })) remove.add(item);
    }
    flush();
    output.push(...group.filter(item => !remove.has(item)).map(item => {
      if (item.kind === 'user' || item.kind === 'history') return { kind: 'message', role: item.message.role || 'assistant', content: item.message.content ?? '' };
      return { kind: 'event', event: item.event.event };
    }));
  }
  return output;
}
