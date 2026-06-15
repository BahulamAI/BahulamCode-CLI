/**
 * Keyboard dock — Mission Control (PRD-055 §5.4).
 *
 * Maps each orbit to the dock hint shown on the second line of the status
 * bar. Pure data so tests, the status bar, and `/help` stay in sync.
 *
 *   import { dockForOrbit } from './dock.mjs';
 *   const hints = dockForOrbit(orbit);          // → [{ key, label }, ...]
 *   const text  = renderDock(hints, paint);     // → ANSI-styled single line
 */

import { ORBITS } from '../state/orbit.mjs';
import { paint, width } from './palette.mjs';
import { term } from './term.mjs';

const DEFAULT = [
  { key: 'Enter', label: 'send'     },
  { key: '/',     label: 'commands' },
  { key: '?',     label: 'help'     },
];

const HINTS = {
  [ORBITS.IDLE]: DEFAULT,
  [ORBITS.DISCOVERY]: DEFAULT,

  [ORBITS.PLANNING]: [
    { key: 'p',   label: 'pause'      },
    { key: 'Esc', label: 'interrupt'  },
    { key: '?',   label: 'why'        },
  ],

  [ORBITS.EXECUTION]: [
    { key: 'd',   label: 'last diff'  },
    { key: 'p',   label: 'pause'      },
    { key: 'Esc', label: 'interrupt'  },
  ],

  [ORBITS.ALIGNMENT]: [
    { key: 'd',   label: 'last result' },
    { key: '?',   label: 'explain'    },
  ],

  [ORBITS.AWAITING]: [
    { key: 'Enter', label: 'approve' },
    { key: 'e',     label: 'edit'    },
    { key: 'r',     label: 're-plan' },
    { key: 'n',     label: 'reject'  },
    { key: '?',     label: 'why'     },
  ],

  [ORBITS.PAUSED]: [
    { key: 'r',   label: 'resume'    },
    { key: 'Esc', label: 'cancel'    },
    { key: 'q',   label: 'quit'      },
  ],
};

/**
 * Return the array of hints for the given orbit.
 * Falls back to the default dock for unknown orbits so the bar is never empty.
 */
export function dockForOrbit(orbit) {
  return HINTS[orbit] || DEFAULT;
}

/**
 * Render a hint list to an ANSI-styled line that fits within `maxWidth`
 * visible characters. Drops trailing entries when they don't fit, never
 * mid-hint truncates.
 */
export function renderDock(hints, maxWidth = term().columns - 2) {
  if (!Array.isArray(hints) || hints.length === 0) return '';
  const parts = [];
  let used = 0;
  for (const h of hints) {
    const piece = `[${h.key}] ${h.label}`;
    const sep = parts.length ? '  ' : '';
    const cost = width(sep) + width(piece);
    if (used + cost > maxWidth) break;
    parts.push(sep + paintHint(h));
    used += cost;
  }
  return parts.join('');
}

function paintHint(h) {
  return paint.text.dim('[') + paint.brand.data(h.key) + paint.text.dim('] ' + h.label);
}
