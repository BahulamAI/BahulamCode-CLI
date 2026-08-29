/**
 * Orbit state machine — Mission Control (PRD-055 §5.2).
 *
 * The "orbit" is the current phase of the session. The status bar reads
 * from this module; the REPL pushes events into it. It is intentionally a
 * pure state machine — no I/O, no side effects, no globals. Each REPL
 * creates one instance.
 *
 *   const orbit = createOrbit();
 *   orbit.on('change', state => statusBar.render(state));
 *   orbit.onEvent({ type: 'tool_call', data: { tool: 'edit_file' } });
 *
 * States (PRD §5.2):
 *   IDLE        — waiting for user input
 *   DISCOVERY   — first message until first plan or edit
 *   PLANNING    — preflight plan running OR plan() sub-agent active
 *   EXECUTION   — write/edit/shell tools firing
 *   ALIGNMENT   — tests / validators running
 *   AWAITING    — approval required
 *   PAUSED      — user pressed `p`
 *
 * Transitions are derived from existing backend SSE events. We never
 * teach the backend about orbits; the CLI infers them from tool activity.
 */

// Tool families used for orbit inference. Mirrors src/ui/icons.mjs but
// scoped to the few orbits actually need.
const PLANNING_TOOLS = new Set(['plan']);
const EXECUTION_TOOLS = new Set(['edit_file', 'write_file', 'write_project', 'shell', 'delete_file']);
const ALIGNMENT_TOOLS = new Set(['run_tests', 'validate_build', 'lint_check', 'validate_file', 'validate_structure', 'git_diff', 'git_status']);
const RESEARCH_TOOLS  = new Set(['search_code', 'search_files', 'grep', 'read_file', 'read_files', 'list_files', 'analyze_code', 'get_project_overview', 'explore']);

export const ORBITS = Object.freeze({
  IDLE:      'IDLE',
  DISCOVERY: 'DISCOVERY',
  PLANNING:  'PLANNING',
  EXECUTION: 'EXECUTION',
  ALIGNMENT: 'ALIGNMENT',
  AWAITING:  'AWAITING',
  PAUSED:    'PAUSED',
});

/**
 * @returns the snapshot consumed by the status bar.
 */
function snapshot(s) {
  return {
    orbit:           s.orbit,
    task:            s.task || '',
    turn:            s.turn,
    maxTurn:         s.maxTurn,
    cost:            s.cost,
    activeTool:      s.activeTool || '',
    subAgents:       s.subAgents,
    paused:          s.paused,
    awaitingTier:    s.awaitingTier || null,
    awaitingTool:    s.awaitingTool || '',
  };
}

export function createOrbit() {
  const state = {
    orbit:        ORBITS.IDLE,
    task:         '',
    turn:         0,
    maxTurn:      0,
    cost:         0,
    activeTool:   '',
    subAgents:    0,           // count of currently-active sub-agents
    paused:       false,
    awaitingTool: '',
    awaitingTier: null,
    _hasEdited:   false,       // for DISCOVERY → EXECUTION transition
    _resumeOrbit: null,        // remembered orbit when paused
  };

  const listeners = new Set();

  function emit() {
    const snap = snapshot(state);
    for (const fn of listeners) {
      try { fn(snap); } catch {}
    }
  }

  function setOrbit(next) {
    if (state.paused && next !== ORBITS.PAUSED && next !== ORBITS.IDLE) {
      // While paused, remember the orbit that would have applied but stay paused.
      state._resumeOrbit = next;
      return;
    }
    if (state.orbit === next) return;
    state.orbit = next;
    emit();
  }

  function inferOrbitFromTool(toolName) {
    if (state.paused) return null;
    if (state.subAgents > 0 && PLANNING_TOOLS.has(toolName)) return ORBITS.PLANNING;
    if (PLANNING_TOOLS.has(toolName)) return ORBITS.PLANNING;
    if (EXECUTION_TOOLS.has(toolName)) {
      state._hasEdited = true;
      return ORBITS.EXECUTION;
    }
    if (ALIGNMENT_TOOLS.has(toolName)) return ORBITS.ALIGNMENT;
    if (RESEARCH_TOOLS.has(toolName)) {
      // Stay in DISCOVERY until first edit; afterwards research stays in
      // current orbit (EXECUTION) so the status doesn't flicker back.
      return state._hasEdited ? null : ORBITS.DISCOVERY;
    }
    return null;
  }

  return {
    state: () => snapshot(state),

    on(event, fn) {
      if (event !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // ── Inbound events from the REPL ──────────────────────────────────

    onUserInput(text) {
      // First user message of the session OR a new turn opens DISCOVERY.
      state.turn++;
      state.task = (text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      state._hasEdited = false;
      state.activeTool = '';
      setOrbit(ORBITS.DISCOVERY);
    },

    onMaxTurn(n) {
      if (typeof n === 'number' && n > 0) {
        state.maxTurn = n;
        emit();
      }
    },

    onTask(text) {
      if (!text) return;
      state.task = String(text).replace(/\s+/g, ' ').trim().slice(0, 80);
      emit();
    },

    onCost(value) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        state.cost = value;
        emit();
      }
    },

    onToolCall(toolName) {
      state.activeTool = toolName || '';
      const next = inferOrbitFromTool(toolName);
      if (next) setOrbit(next);
      else emit();
    },

    onToolResult() {
      state.activeTool = '';
      emit();
    },

    onSubAgentStart() {
      state.subAgents = Math.max(0, state.subAgents) + 1;
      setOrbit(ORBITS.PLANNING);
    },

    onSubAgentEnd() {
      state.subAgents = Math.max(0, state.subAgents - 1);
      // Fall back to whatever the parent was doing — we don't track that
      // precisely, so go to EXECUTION if an edit has happened, else
      // DISCOVERY. The next tool_call event will refine.
      if (state.subAgents === 0) {
        setOrbit(state._hasEdited ? ORBITS.EXECUTION : ORBITS.DISCOVERY);
      } else {
        emit();
      }
    },

    onApprovalRequired({ tool, tier } = {}) {
      state.awaitingTool = tool || '';
      state.awaitingTier = tier || null;
      setOrbit(ORBITS.AWAITING);
    },

    onApprovalResolved() {
      state.awaitingTool = '';
      state.awaitingTier = null;
      // Drop back to the inferred orbit for the active tool, or EXECUTION
      // if we have an active tool but can't classify, or IDLE.
      const inferred = inferOrbitFromTool(state.activeTool) || (state._hasEdited ? ORBITS.EXECUTION : ORBITS.DISCOVERY);
      setOrbit(inferred);
    },

    onComplete({ cost } = {}) {
      if (typeof cost === 'number') state.cost = cost;
      state.activeTool = '';
      setOrbit(ORBITS.IDLE);
    },

    onPause() {
      if (state.paused) return;
      state.paused = true;
      state._resumeOrbit = state.orbit;
      state.orbit = ORBITS.PAUSED;
      emit();
    },

    onResume() {
      if (!state.paused) return;
      state.paused = false;
      const resume = state._resumeOrbit || ORBITS.IDLE;
      state._resumeOrbit = null;
      state.orbit = resume;
      emit();
    },

    /**
     * Generic event router so the REPL can feed raw SSE events without a
     * giant switch in this module. Returns true if the event was handled.
     */
    onEvent(event) {
      if (!event || !event.type) return false;
      const { type, data } = event;
      switch (type) {
        case 'tool_call':
        case 'tool_request':
          this.onToolCall(data?.tool || '');
          return true;
        case 'tool_result':
        case 'tool_done':
          this.onToolResult();
          return true;
        case 'sub_agent_start':
          this.onSubAgentStart();
          return true;
        case 'sub_agent_complete':
          this.onSubAgentEnd();
          return true;
        case 'approval_required':
          this.onApprovalRequired({ tool: data?.tool, tier: data?.tier });
          return true;
        case 'approval_granted':
        case 'approval_denied':
          this.onApprovalResolved();
          return true;
        case 'complete': {
          const usage = data?.usage || {};
          this.onComplete({ cost: usage.total_cost_usd ?? usage.cost_usd });
          return true;
        }
        case 'plan_created':
          this.onTask(data?.title || data?.task || '');
          return true;
        default:
          return false;
      }
    },
  };
}
