/**
 * Resume Mode — decide how much of a transcript to send to the agent (PRD-068 §5.14.3).
 *
 * Rule of thumb: if the projected context (transcript + system prompt overhead)
 * fits comfortably in the current model's window, resume with `full` silently.
 * Only ask the user when we're above the highWatermark.
 *
 * Config lives in .kepler/settings.json:
 *   {
 *     "resume": {
 *       "highWatermark": 0.50,   // prompt above this (default 50%)
 *       "hardCap":       0.85    // refuse full above this  (default 85%)
 *     }
 *   }
 */

// System overhead — tools, memory, .kepler/ context, kepler.md, skills index.
// Rough constant; individual runs vary. Tuned toward "assume ~4k of overhead".
const DEFAULT_SYSTEM_OVERHEAD_TOKENS = 4000;

// Model context windows we know about. Fallback used when unknown.
// Keep this table small — it's a hint, not a source of truth.
const MODEL_CONTEXT_WINDOWS = {
  'anthropic/claude-sonnet-4':          200000,
  'anthropic/claude-4-sonnet-20250522': 200000,
  'anthropic/claude-opus-4':            200000,
  'deepseek/deepseek-v4-flash':         128000,
  'deepseek/deepseek-v4-pro':           128000,
  'deepseek/deepseek-chat-v3-0324':     128000,
  'openai/gpt-5':                       400000,
  'openai/gpt-5-mini':                  400000,
  'google/gemini-2.5-pro':              1000000,
  'xiaomi/mimo-v2.5':                   128000,
};
const DEFAULT_CONTEXT_WINDOW = 128000;

function contextWindowHintInfo(hint) {
  const raw = typeof hint === 'number'
    ? hint
    : hint?.context_length ?? hint?.contextLength ?? hint?.tokens ?? hint?.windowSize;
  const tokens = Number(raw);
  if (Number.isFinite(tokens) && tokens > 0) {
    return {
      tokens: Math.trunc(tokens),
      known: true,
      source: hint?.source || 'backend_catalog',
    };
  }
  return null;
}

export function modelContextWindowInfo(model, contextWindowHint = null) {
  const hinted = contextWindowHintInfo(contextWindowHint);
  if (hinted) return hinted;
  if (model && MODEL_CONTEXT_WINDOWS[model]) {
    return { tokens: MODEL_CONTEXT_WINDOWS[model], known: true, source: 'model_map' };
  }
  return { tokens: DEFAULT_CONTEXT_WINDOW, known: false, source: 'fallback' };
}

export function modelContextWindow(model, contextWindowHint = null) {
  return modelContextWindowInfo(model, contextWindowHint).tokens;
}

/**
 * Decide the resume mode for a session based on projected context usage.
 *
 * @param {object} args
 * @param {number} args.transcriptTokens  — projected transcript size when serialized
 * @param {string} [args.model]           — current agent model id
 * @param {object|number} [args.contextWindow] — backend/catalog context-window hint
 * @param {object} [args.settings]        — .kepler/settings.json contents (optional)
 * @param {number} [args.systemOverhead]  — override system overhead (defaults to 4k)
 * @returns {{
 *   mode:          'full' | 'ask' | 'no-full-allowed',
 *   defaultChoice: 'full' | 'tail-20' | 'summary',
 *   projected:     number,   // total projected tokens
 *   windowSize:    number,   // model window
 *   usageRatio:    number,   // projected / windowSize
 *   highWatermark: number,
 *   hardCap:       number,
 * }}
 *
 * `mode = 'full'`             — resume immediately in full mode; do not prompt
 * `mode = 'ask'`              — show the tri-choice overlay
 * `mode = 'no-full-allowed'`  — above hardCap; user must pick a tail mode or summary
 */
export function decideResumeMode({
  transcriptTokens,
  model,
  contextWindow = null,
  settings,
  systemOverhead = DEFAULT_SYSTEM_OVERHEAD_TOKENS,
} = {}) {
  const cfg = settings?.resume || {};
  const highWatermark = clampRatio(cfg.highWatermark, 0.50);
  const hardCap = clampRatio(cfg.hardCap, 0.85);

  const windowInfo = modelContextWindowInfo(model, contextWindow);
  const windowSize = windowInfo.tokens;
  const projected = Math.max(0, Number(transcriptTokens) || 0) + systemOverhead;
  const usageRatio = windowSize > 0 ? projected / windowSize : 0;

  let mode;
  let defaultChoice;
  if (usageRatio > hardCap) {
    mode = 'no-full-allowed';
    // Above hardCap — last 20 turns is usually the least-lossy fit; user picks.
    defaultChoice = 'tail-20';
  } else if (usageRatio > highWatermark) {
    mode = 'ask';
    defaultChoice = 'full';
  } else {
    mode = 'full';
    defaultChoice = 'full';
  }

  return {
    mode,
    defaultChoice,
    projected,
    windowSize,
    windowKnown: windowInfo.known,
    windowSource: windowInfo.source,
    usageRatio,
    highWatermark,
    hardCap,
  };
}

/**
 * Estimate the context tokens for a candidate mode. Used by the tri-choice
 * overlay to render "62k / 14k / 2k" per option before the user commits.
 *
 * @param {'full' | 'checkpoint-full' | 'summary' | 'tail-10' | 'tail-20' | 'recap+tail'} choice
 * @param {number} fullTokens — projected transcript size in full mode
 * @param {object} [opts]
 * @returns {number} projected tokens for the chosen mode
 */
export function projectedTokensForChoice(choice, fullTokens, opts = {}) {
  const {
    tailTurns = null,
    // Rough per-turn estimate. Summary block is ~1-2k.
    tailBaseTokens = 2000,
    perTailTurnTokens = 500,
    summaryBaseTokens = 2000,
    resumeSummary = null,
  } = opts;

  switch (choice) {
    case 'full':
      return Math.max(0, Number(fullTokens) || 0);
    case 'checkpoint-full': {
      const full = Math.max(0, Number(fullTokens) || 0);
      const fullMessages = Math.max(0, Number(resumeSummary?.fullMessageCount) || 0);
      const covered = Math.max(0, Number(resumeSummary?.sourceMessageCount) || 0);
      if (!fullMessages || covered <= 0) return full;
      const remainingMessages = Math.max(0, fullMessages - covered);
      if (remainingMessages === 0) return summaryBaseTokens;
      return summaryBaseTokens + (perTailTurnTokens * remainingMessages);
    }
    case 'tail-10':
      return tailBaseTokens + (10 * perTailTurnTokens);
    case 'tail-20':
      return tailBaseTokens + (20 * perTailTurnTokens);
    case 'recap+tail':
      return tailBaseTokens + ((Number(tailTurns) || 8) * perTailTurnTokens);
    case 'summary':
      return summaryBaseTokens;
    default:
      return Math.max(0, Number(fullTokens) || 0);
  }
}

function clampRatio(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  if (n > 1) return fallback;
  return n;
}

/**
 * Format tokens with a k/M suffix — "8k", "62k", "1.2M".
 * Used by the picker + overlay so numbers fit in narrow columns.
 */
export function formatTokens(n) {
  const v = Math.round(Number(n) || 0);
  if (v < 1000) return `${v}`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}
