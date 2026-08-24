/**
 * PRD-092 Slice E — Input lock state (multi-attach input arbitration).
 *
 * Per PRD §6.5:
 *   - The first attach implicitly holds the input lock.
 *   - Later attaches join in WATCH mode (may render events, may
 *     approve/deny, may NOT send_message / interrupt / switch_model).
 *   - `take_input_lock` triggers a STEAL WITH GRACE:
 *       1. Emit input_lock_changed { holder: current, pending_transfer: att_new }
 *       2. Current holder has 3s to release_input_lock gracefully
 *       3. After 3s (or on release) → holder := att_new,
 *          emit input_lock_changed { holder: att_new }
 *   - Approvals bypass the lock. That's an authorization act, not
 *     a typing act; enforced by the socket-server, not this module.
 *
 * State model:
 *   holder      : attach_id | null      currently owns typing input
 *   since       : ISO-8601 UTC          when holder was assigned
 *   pending     : attach_id | null      the challenger waiting on a steal
 *   pendingTimer: NodeTimeout | null    the 3s grace timer
 *
 * All mutations go through the exported functions so the emitters
 * (repl.mjs wiring) always publish an `input_lock_changed` event.
 */

const GRACE_MS = 3000;

const _state = {
  holder: null,        // attach_id | null
  since: null,         // ISO string
  pending: null,       // attach_id | null
  pendingTimer: null,  // NodeTimeout | null
};

let _emit = null;      // (type, data) → void — set by wireEmit()

/**
 * Wire the event emitter. The daemon (repl.mjs) sets this to a function
 * that writes to the event tap so `input_lock_changed` fans out to all
 * attached clients.
 */
export function wireEmit(emitFn) {
  _emit = typeof emitFn === 'function' ? emitFn : null;
}

function _now() { return new Date().toISOString(); }

function _publish(extra = {}) {
  if (!_emit) return;
  try {
    _emit('input_lock_changed', {
      holder: _state.holder,
      since: _state.since,
      pending_transfer: _state.pending,
      ...extra,
    });
  } catch { /* never blocks a state change */ }
}

// ── attach lifecycle ─────────────────────────────────────────────────

/**
 * First attach auto-takes the lock. Later attaches join in watch mode.
 * Call from the socket-server hello handler.
 *
 * @param {string} attachId
 * @returns {{holder: string, kind: 'holder'|'watch'}}
 */
export function onAttachJoined(attachId) {
  if (_state.holder == null) {
    _state.holder = attachId;
    _state.since = _now();
    _publish();
    return { holder: attachId, kind: 'holder' };
  }
  return { holder: _state.holder, kind: 'watch' };
}

/**
 * If the leaving attach was the holder, transfer the lock — to the pending
 * challenger if there is one, else to nobody (holder=null). If it was a
 * watcher, no state change.
 */
export function onAttachLeft(attachId) {
  const wasHolder = _state.holder === attachId;
  const wasPending = _state.pending === attachId;
  if (wasPending) _clearPending();
  if (!wasHolder) return;
  if (_state.pending) {
    _state.holder = _state.pending;
    _state.since = _now();
    _clearPending();
  } else {
    _state.holder = null;
    _state.since = null;
  }
  _publish();
}

// ── commands ─────────────────────────────────────────────────────────

/**
 * `take_input_lock` command — steal-with-grace protocol.
 *
 * If the requester is already the holder → no-op (return current state).
 * If there's no holder → immediate takeover.
 * Otherwise → set pending, schedule 3s timer to force-transfer.
 *
 * Returns the state after the request is processed (not after the
 * grace timer fires).
 */
export function takeInputLock(attachId) {
  if (_state.holder === attachId) {
    return { holder: attachId, pending: null, immediate: true };
  }
  if (_state.holder == null) {
    _state.holder = attachId;
    _state.since = _now();
    _publish();
    return { holder: attachId, pending: null, immediate: true };
  }
  // Someone else already requested — drop their pending in favor of the
  // newer one (last-writer-wins). Restart the grace timer.
  _clearPending();
  _state.pending = attachId;
  _publish();
  _state.pendingTimer = setTimeout(() => {
    // Grace elapsed → force transfer. Read pending BEFORE _clearPending
    // (which nulls it) so the check + assign happen against the value at
    // schedule time, not the intermediate cleared state.
    if (_state.pending !== attachId) return;  // preempted by another take
    _state.holder = attachId;
    _state.since = _now();
    _state.pending = null;
    _state.pendingTimer = null;
    _publish();
  }, GRACE_MS);
  // No .unref(): we want the daemon event loop to be kept alive by a
  // pending grace transfer. In tests, connected sockets already keep
  // the loop alive, so no diff. In prod, this prevents a bahulamd whose
  // ONLY outstanding work is a grace-steal from exiting mid-transfer.
  return { holder: _state.holder, pending: attachId, immediate: false, graceMs: GRACE_MS };
}

/**
 * `release_input_lock` command — the current holder yields.
 * If there's a pending challenger, they take the lock immediately.
 * If not, the lock becomes null (next `take_input_lock` from anyone wins).
 */
export function releaseInputLock(attachId) {
  if (_state.holder !== attachId) return { ignored: true, reason: 'not_holder' };
  if (_state.pending) {
    _state.holder = _state.pending;
    _state.since = _now();
    _clearPending();
  } else {
    _state.holder = null;
    _state.since = null;
  }
  _publish();
  return { holder: _state.holder };
}

// ── query ────────────────────────────────────────────────────────────

/** Read current lock state. Used by socket-server to enforce writes. */
export function currentHolder() { return _state.holder; }
export function isHolder(attachId) { return _state.holder === attachId; }

/** For tests and `bahulam status`. */
export function snapshot() {
  return {
    holder: _state.holder,
    since: _state.since,
    pending: _state.pending,
  };
}

/** Reset (tests only, or on daemon shutdown). */
export function resetInputLock() {
  _clearPending();
  _state.holder = null;
  _state.since = null;
}

// ── internal ─────────────────────────────────────────────────────────

function _clearPending() {
  if (_state.pendingTimer) { clearTimeout(_state.pendingTimer); _state.pendingTimer = null; }
  _state.pending = null;
}
