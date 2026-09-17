/**
 * Structured tool errors.
 *
 * Plugin tool handlers used to return { success: false, output: "<msg>" }
 * and thrown errors got wrapped the same way — the message became a
 * blob the agent had to re-read to figure out what went wrong.
 *
 * This module standardizes the envelope so the trace UI can filter and
 * the agent can self-correct on the next turn without re-parsing prose.
 *
 * Handler patterns
 * ----------------
 *
 * Return a structured error explicitly:
 *
 *   import { toolError } from '../../src/core/tool-error.mjs';
 *   if (!scene) return toolError('MISSING_SCENE', `Scene "${slug}" not found.`,
 *                                'Call create_scene(name="<slug>") first.');
 *
 * OR throw a ToolError:
 *
 *   throw new ToolError('INVALID_ARGS', 'position must be [x,y,z]', 'Pass a length-3 array.');
 *
 * OR throw a plain Error — normalizeToolResult wraps it as { code: 'UNKNOWN' }
 * so nothing crashes the executor.
 *
 * Error codes (extend freely; keep short, SCREAMING_SNAKE_CASE)
 * ---
 *   INVALID_ARGS       — schema violation or missing required field
 *   MISSING_RESOURCE   — referenced id (node, ref, section, ...) not found
 *   IO                 — filesystem or network operation failed
 *   PROVIDER_UNAVAILABLE — external provider missing key or offline
 *   PROVIDER_ERROR     — external provider returned an error response
 *   STATE_ERROR        — plugin state DB read/write failure
 *   RATE_LIMITED       — provider or platform rate limit hit
 *   TIMEOUT            — operation exceeded its deadline
 *   UNKNOWN            — thrown Error that wasn't a ToolError (fallback)
 */

export class ToolError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'ToolError';
    this.code = String(code || 'UNKNOWN');
    this.hint = hint ? String(hint) : null;
  }
}

/**
 * Build a structured error envelope suitable for `return`-ing from a
 * plugin tool handler. Never throws.
 */
export function toolError(code, message, hint) {
  return {
    success: false,
    output: String(message || ''),
    error: {
      code: String(code || 'UNKNOWN'),
      message: String(message || ''),
      ...(hint ? { hint: String(hint) } : {}),
    },
  };
}

/**
 * Normalize an arbitrary handler return value or thrown error into the
 * canonical shape:
 *
 *   Success:  { success: true,  output, _tool, _plugin }
 *   Failure:  { success: false, output, error: { code, message, hint?, stack? },
 *               _tool, _plugin }
 *
 * `stack` is only attached in DEBUG mode so the trace export can show
 * it without leaking noise into normal responses.
 *
 * `traceId` is optional; when provided by the caller it's forwarded so
 * export / logs can join back to the trace row.
 */
export function normalizeToolResult({ tool, plugin, traceId }, result, thrown) {
  const meta = {
    _tool: tool,
    ...(plugin ? { _plugin: plugin } : {}),
    ...(traceId ? { _trace_id: traceId } : {}),
  };

  if (thrown) {
    const err = thrown instanceof ToolError
      ? { code: thrown.code, message: thrown.message, ...(thrown.hint ? { hint: thrown.hint } : {}) }
      : { code: 'UNKNOWN', message: String(thrown?.message || thrown) };
    if (process.env.DEBUG && thrown?.stack) err.stack = String(thrown.stack).split('\n').slice(0, 6).join('\n');
    const outputText = [`[${err.code}] ${err.message}`, err.hint ? `(hint: ${err.hint})` : ''].filter(Boolean).join(' ');
    return { success: false, output: outputText, error: err, ...meta };
  }

  if (!result || typeof result !== 'object') {
    return { success: true, output: result, ...meta };
  }

  if (result.success !== false) {
    return { success: true, output: result.output ?? result, ...meta };
  }

  // success === false — extract structured error if present, else synthesize one
  const err = result.error && typeof result.error === 'object'
    ? {
        code: String(result.error.code || 'UNKNOWN'),
        message: String(result.error.message || result.output || 'Tool call failed.'),
        ...(result.error.hint ? { hint: String(result.error.hint) } : {}),
      }
    : {
        code: 'UNKNOWN',
        message: typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? 'Tool call failed.'),
      };

  // The agent reads `output` on the next turn — make it self-contained so
  // the LLM doesn't need to re-parse. Format: [CODE] message (hint: ...)
  const rawOutput = typeof result.output === 'string' && result.output.trim()
    ? result.output
    : err.message;
  const alreadyHasCode = rawOutput.startsWith(`[${err.code}]`);
  const alreadyHasHint = err.hint && rawOutput.toLowerCase().includes(String(err.hint).toLowerCase());
  const outputText = [
    alreadyHasCode ? rawOutput : `[${err.code}] ${rawOutput}`,
    err.hint && !alreadyHasHint ? `(hint: ${err.hint})` : '',
  ].filter(Boolean).join(' ');
  return { success: false, output: outputText, error: err, ...meta };
}

/**
 * Format an error envelope as a short one-line summary for logs and
 * compact trace rows.
 */
export function formatErrorSummary(err) {
  if (!err) return '';
  const code = err.code || 'UNKNOWN';
  const msg = String(err.message || '').replace(/\s+/g, ' ').slice(0, 240);
  return `[${code}] ${msg}${err.hint ? ` — hint: ${String(err.hint).slice(0, 140)}` : ''}`;
}

/**
 * Build a compact hint the next agent turn can consume so it can
 * self-correct without re-reading a raw stack trace.
 *
 * Example:
 *   "Previous tool call `create_node` failed. [MISSING_RESOURCE] Node
 *    'chair_99' not found. Hint: call get_scene(slug='cafe') to see
 *    current node ids."
 */
export function buildNextTurnHint({ tool, error }) {
  if (!error) return '';
  const parts = [`Previous tool call \`${tool || 'unknown'}\` failed.`];
  parts.push(`[${error.code || 'UNKNOWN'}] ${error.message || ''}`.trim());
  if (error.hint) parts.push(`Hint: ${error.hint}`);
  return parts.join(' ');
}
