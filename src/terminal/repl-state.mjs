/**
 * REPL shared state.
 *
 * Extracted from repl.mjs so other repl-* modules can import mutable state
 * without depending on the giant repl.mjs (which is being split incrementally).
 *
 * These objects are mutated in place — importers read and write properties
 * directly. That preserves the current single-source-of-truth pattern the
 * REPL relied on when everything lived in one file.
 */

// Ref holder for the Mission Control orbit state machine. The REPL loop
// creates the orbit at startup and assigns `orbitRef.current = createOrbit()`.
// Other modules read via orbitRef.current and can null it out during flows
// like previewResumeSession() that need to temporarily suppress state updates.
export const orbitRef = { current: null };

// Ref holder for the SessionManager. The REPL loop instantiates it and
// assigns `sessionMgrRef.current = new SessionManager(...)`. Resume/preview
// flows null it out temporarily to suppress transcript writes during the
// preview overlay, then restore it.
export const sessionMgrRef = { current: null };

// Per-turn runtime state — content streaming buffers, spinner interval,
// pending tool-head, explore-run counters, block-boundary tracker. All
// mutated in place by tool renderers, event handlers, and the streaming
// pipeline. Grouped into one object so consumers can `import { runtime }`
// once instead of pulling twelve individual let-bindings across modules.
export const runtime = {
  // Content streaming (SSE partials that flush as a single markdown block).
  streamBuffer: '',
  streamedPartialText: '',
  streamTimer: null,
  renderedContentThisTurn: false,
  contentHeaderPrinted: false,
  afterContentFlush: null,   // callback fired after each flushContent()

  // Tool head + block-boundary tracking (single-line vs 2-line card emit).
  pendingHead: null,          // { callId, head, indent } buffered until result arrives
  lastRenderedBlock: null,    // 'tool' | 'content' | 'thinking' | 'status' | 'plan' | null
  renderedToolResults: new Set(),
  renderedFileDiffPreviews: new Set(),

  // Explore-run collapse (read/list/search/index bursts as concise progress).
  exploreRun: { counts: {}, recent: [], lineActive: false, lastPrintedSummary: '', lastPrintedTotal: 0, lastPrintedAt: 0 },
  foldedSubAgentTools: null, // { agentType, entries, startedAt } for default/quiet folded sub-agent tools

  // Animated spinner state (single shared interval; text/frame drive inPlace).
  spinInterval: null,
  spinText: '',
  spinFrame: 0,
  // Activity phase tracking — elapsed time + progress counters on the
  // status line. spinPhase changes reset spinStartedAt; text updates
  // within the same phase keep the clock running so "thinking · 14s"
  // and "explore agent · 32s · 12 calls" count up live.
  spinPhase: null,        // 'thinking' | 'status' | `tool:<id>` | `sub:<type>` | null
  spinStartedAt: 0,       // Date.now() when the current phase began
  spinToolCalls: 0,       // per-phase tool-call counter (sub-agents)

  // Sub-agent live tool window: while a sub-agent runs (queue active),
  // its inner tool calls stream into a fixed-height status block (last
  // N lines under the spinner) instead of appending to the transcript.
  // Full detail stays on the recorded cards (/expand, /last, `d`).
  subAgentWindow: { active: false, lines: [] },
};

// Full session state for the current CLI process. Set by the REPL loop
// as backend events (session_info, complete, etc.) arrive. Fields that
// look "server-authoritative" (subscriptionTier, credits*) come from
// session_info + complete payloads; the rest is CLI-local bookkeeping.
export const session = {
  id: null,                  // set by backend on first turn via session_info event
  startTime: Date.now(),
  inputTokens: 0,
  outputTokens: 0,
  // Per-turn context indicator for the dock strip. Updated at each
  // AGENT_COMPLETE from the backend's usage.total_input_tokens (the
  // cumulative input the primary agent sent this turn across all its
  // internal inferences). Rough proxy for "how big is the prompt right
  // now" — approximates what the NEXT user turn will pay before any
  // growth. Reset by /new.
  lastTurnInputTokens: 0,
  toolCalls: 0,        // primary-agent tool calls in the current turn
  subAgentToolCalls: 0,// forwarded internal sub-agent tool calls in the current turn
  totalToolCalls: 0,   // across all turns
  totalPrimaryToolCalls: 0,
  totalSubAgentToolCalls: 0,
  turns: 0,
  history: [],         // display transcript (can include reconstructed tool entries)
  agentHistory: [],    // backend continuity payload (compact or full)
  inputHistory: [],    // previous prompts (for Up/Down)
  user: null,          // { github_username, email, role }
  model: null,         // from backend user profile
  modelLimits: {},     // role -> {model, context_length, max_output, source}
  blockedOps: 0,       // safety guardrail blocks
  delegations: [],     // agent delegation events: { from, to, time }
  phases: [],          // phase history: { name, time }
  inSubAgent: false,   // true while a sub-agent is running (for indented tool display)
  filesChanged: [],    // files modified this session
  filesRead: [],       // files read this turn
  lastTurnDuration: 0,
  toolCounts: {},      // per-tool histogram (mission report)
  subAgentCounts: {},  // per-sub-agent histogram (mission report)
  savedUsd: 0,         // total sub-agent cost (for "saved by routing")
  lastTask: '',        // most recent user prompt (mission report title)
  lastReasoning: '',   // captured from agent for /why
  budgetUsd: null,     // /budget cap, null = unlimited
  budgetExceeded: false,
  costBreakdown: [],   // per-model usage: [{ model, role, input_tokens, output_tokens, cost }]
  totalCost: 0,        // accumulated session cost (USD)
  costAccurate: false, // true if backend provides per-model breakdown
  modelOverrides: {},  // session-local role -> model overrides sent to backend
  modelMode: null,     // named mode (fast|thinking|extra|max) sent as model_mode
  routePreference: null, // --route platform|byok; controls catalog validation only
  isByok: false,       // set from session_info; hides cost + credits when true
  // ── Subscription / credit state (server-authoritative; set from
  //    session_info + complete events) ──
  subscriptionTier: null,        // 'free' | 'cli' | 'pro' | 'pro_plus' | 'enterprise'
  creditsTotal: null,            // remaining credits (included + purchased)
  creditsIncluded: null,         // remaining included credits this period
  creditsPurchased: null,        // remaining purchased credits
  creditsLimit: null,            // per-period included credits limit
  creditsCharged: 0,             // session-cumulative server-reported charges
  creditsLowWarned: false,       // emit the low-balance hint only once per turn
  rateLimit: null,               // rolling message-window state from backend
  msgsLowWarned: false,          // emit the low-window hint only once per turn
};
