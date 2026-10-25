// SpeechRecognitionEvent.results includes the whole current transcript.
// resultIndex only marks the first result changed by this event.
function speechTranscript(event) {
  const parts = [];
  for (let i = 0; i < (event?.results?.length || 0); i++) {
    const text = String(event.results[i]?.[0]?.transcript || '').trim();
    if (text) parts.push(text);
  }
  return parts.join(' ').replace(/\s+([,.!?;:])/g, '$1');
}
