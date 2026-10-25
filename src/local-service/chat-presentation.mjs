/** Message boundaries for the browser. Does not change the agent's input/history. */
export class AssistantMessageStream {
  constructor() {
    this.streams = new Map();
    this.sequence = 0;
  }

  accept(event, turnId) {
    const { type, data = {} } = event || {};
    const agent = data.sub_agent;
    const author = String((typeof agent === 'string' ? agent : agent?.name || agent?.slug) || data.agent_name || 'Assistant');
    const key = JSON.stringify([turnId, author]);
    if (['tool_call', 'tool_request', 'complete'].includes(type)) {
      this.streams.delete(key);
      return null;
    }
    if (type !== 'content' && type !== 'content_partial') return null;
    const text = String(data.text ?? data.content ?? '');
    const partial = type === 'content_partial';
    const sourceId = data.message_id || data.messageId || null;
    let stream = this.streams.get(key);
    // A complete snapshot can echo its streamed text. It closes the message;
    // the next stream or tool boundary starts another message in the same turn.
    const echo = stream?.closed && !partial && text === stream.text && sourceId === stream.sourceId;
    if (!stream || (sourceId && stream.sourceId && sourceId !== stream.sourceId) || (stream.closed && !echo)) {
      stream = { id: `${turnId}:message:${++this.sequence}`, sourceId, text: '', closed: false };
      this.streams.set(key, stream);
    }
    if (sourceId) stream.sourceId = sourceId;
    const previous = stream.text;
    const append = partial || Boolean(previous && text && !text.startsWith(previous));
    stream.text = append ? previous + text : text || previous;
    stream.closed = !partial;
    return {
      turn_id: turnId,
      message_id: stream.id,
      author,
      text: append ? text : stream.text.slice(previous.length),
      content: stream.text,
      replace: false,
      partial,
    };
  }

  finish(turnId) {
    for (const key of this.streams.keys()) if (JSON.parse(key)[0] === turnId) this.streams.delete(key);
  }
}
