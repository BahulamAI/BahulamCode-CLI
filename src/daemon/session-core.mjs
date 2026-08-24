/**
 *  §6.1 / §6.8 — SessionCore: the daemon-owned view of a session.
 *
 * The daemon (bahulamd, .3+) owns:
 *   1. The agent loop (SSE consumer → tool executor → event dispatch).
 *   2. The event log ( §6.4).
 *   3. The message history + cumulative usage — everything an attach
 *      client needs to reconstruct the transcript on reconnect.
 *
 * The attach client () owns everything rendering-related:
 *   spinner, per-line dedup, block-boundary tracking, sub-agent tool
 *   window, input-history for arrow keys, one-shot toasts, etc.
 *
 * repl-state.mjs already holds both categories mixed together (see the
 * `session` and `runtime` exports). This module is the *classification*
 * of which fields the daemon persists across attach/detach and which
 * belong to the attached client — plus a small snapshot/restore API
 * bahulamd will call to write/read the periodic snapshot-<seq>.json
 * files that seed a re-attaching client.
 *
 * IMPORTANT — cache invariance ( §7 note we keep repeating):
 * NOTHING in this module gets sent to the LLM. The snapshot is written
 * to local disk only. The daemon's outbound HTTP body to /api/execute
 * is constructed exactly the same way it is today — via existing code
 * paths that read session.agentHistory / session.messages. The
 * BAHULAM_CAPTURE_REQUEST hook (see stream-client.mjs) exists so a
 * later slice can hard-assert that byte identity.
 */

import { session as sharedSession } from '../terminal/repl-state.mjs';

// ── field classification ─────────────────────────────────────────────

/**
 * Daemon-owned session fields. These persist across detach/attach and
 * appear in snapshot-<seq>.json. Order and shape match repl-state.mjs
 * so callers don't have to translate.
 *
 * A field belongs here if:
 *   • Its value is the source of truth for what happened in the session
 *     (message history, cumulative usage, cost, files touched, …).
 *   • A re-attaching client needs it to render an accurate transcript.
 *   • It doesn't change based on which attach is watching.
 */
export const DAEMON_OWNED_FIELDS = Object.freeze([
  'id',
  'startTime',
  'inputTokens',
  'outputTokens',
  'toolCalls',
  'subAgentToolCalls',
  'totalToolCalls',
  'totalPrimaryToolCalls',
  'totalSubAgentToolCalls',
  'turns',
  'history',
  'agentHistory',
  'user',
  'model',
  'modelLimits',
  'blockedOps',
  'delegations',
  'phases',
  'filesChanged',
  'filesRead',
  'lastTurnDuration',
  'toolCounts',
  'subAgentCounts',
  'savedUsd',
  'lastTask',
  'lastReasoning',
  'budgetUsd',
  'budgetExceeded',
  'costBreakdown',
  'totalCost',
  'costAccurate',
  'modelOverrides',
  'modelMode',
  'routePreference',
  'isByok',
  'subscriptionTier',
  'creditsTotal',
  'creditsIncluded',
  'creditsPurchased',
  'creditsLimit',
  'creditsCharged',
  'rateLimit',
]);

/**
 * Client-owned session fields. These belong to whichever attach is
 * currently connected and MUST NOT be included in snapshots — replaying
 * them on re-attach would produce wrong UX (e.g. a "low credits" toast
 * shown twice, arrow-key history from a stranger's terminal).
 *
 * A field belongs here if:
 *   • It exists to dedup a per-attach UI effect (`*_LowWarned` flags).
 *   • It's input state tied to a keyboard (`inputHistory`).
 *   • It's a rendering flag whose value depends on the current visible
 *     transcript, not the session's actual state (`inSubAgent`).
 */
export const CLIENT_OWNED_SESSION_FIELDS = Object.freeze([
  'inputHistory',
  'inSubAgent',
  'creditsLowWarned',
  'msgsLowWarned',
  '_lastEmittedThinking',
]);

/**
 * The `runtime` object in repl-state.mjs is ENTIRELY client-owned.
 * It's stream buffers, spinner frames, explore-run counters, sub-agent
 * live windows — all rendering. Listed here for completeness; the
 * daemon never reads or writes runtime.*.
 */
export const CLIENT_OWNED_RUNTIME_FIELDS = Object.freeze([
  'streamBuffer', 'streamedPartialText', 'streamTimer',
  'renderedContentThisTurn', 'contentHeaderPrinted', 'afterContentFlush',
  'pendingHead', 'lastRenderedBlock', 'renderedToolResults', 'renderedFileDiffPreviews',
  'exploreRun', 'foldedSubAgentTools',
  'spinInterval', 'spinText', 'spinFrame', 'spinPhase', 'spinStartedAt', 'spinToolCalls',
  'subAgentWindow',
]);

// ── snapshot / restore ───────────────────────────────────────────────

/**
 * Extract the daemon-owned fields from a session-like object into a
 * plain, JSON-serializable snapshot. Use `sharedSession` by default so
 * bahulamd can call `snapshotSession()` with no arg and get the right
 * thing; tests can pass an alternate source.
 *
 * Missing fields are omitted (not written as `undefined`) so the
 * snapshot file stays clean. Nested objects/arrays are shallow-copied
 * — callers that mutate history/agentHistory after snapshotting will
 * see the mutation reflected. That's fine for the daemon (single
 * writer, snapshot-then-continue pattern), but tests that reuse
 * snapshots across mutations should structuredClone() the return.
 */
export function snapshotSession(source = sharedSession) {
  const out = {};
  for (const key of DAEMON_OWNED_FIELDS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Apply a snapshot back onto a session-like object. Only DAEMON_OWNED
 * fields are copied — a maliciously crafted snapshot that includes
 * runtime.* or CLIENT_OWNED_SESSION_FIELDS is silently ignored to
 * prevent snapshot injection from replaying per-attach UI state.
 *
 * Fields the snapshot doesn't mention are left unchanged on `target`
 * (not zeroed out). That way a partial snapshot from an older schema
 * version still restores what it knows without wiping newer fields.
 */
export function restoreSession(snapshot, target = sharedSession) {
  if (!snapshot || typeof snapshot !== 'object') return target;
  for (const key of DAEMON_OWNED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      target[key] = snapshot[key];
    }
  }
  return target;
}

// ── introspection ────────────────────────────────────────────────────

/**
 * Classify a single field name. Useful in tests to guarantee every
 * field in repl-state.mjs is accounted for (nothing accidentally lives
 * in "neither" — new fields must be classified when added).
 */
export function classifyField(name) {
  if (DAEMON_OWNED_FIELDS.includes(name)) return 'daemon';
  if (CLIENT_OWNED_SESSION_FIELDS.includes(name)) return 'client';
  return 'unclassified';
}
