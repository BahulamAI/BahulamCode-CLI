// Preserve the accepted resume replay, then include messages added in either view.
export function rustTranscriptItems(session) {
  const prefix = session.rustSnapshotItems || [];
  const offset = session.rustSnapshotItems ? session.rustSnapshotHistoryLength || 0 : 0;
  return [...prefix, ...(session.history || []).slice(offset).map(item => ({
    kind: 'message', role: item?.role || 'assistant', content: item?.content ?? item?.text ?? '',
  }))];
}
