// Shared canonical display projection. Keep the saved JSONL byte representation unchanged.
export function sanitizeEventValue(value, depth = 0) {
  if (depth > 8) return '[truncated-depth]';
  if (typeof value === 'string') {
    return value.length > 10000 ? value.slice(0, 10000) + '\n[...truncated...]' : value;
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeEventValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = Object.create(null);
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      out[key] = sanitizeEventValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

