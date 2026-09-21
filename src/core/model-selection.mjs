/**
 * Shared model-selection contract used by every runtime transport.
 *
 * Remote/bundled send the context fields to /api/execute. Local/direct use
 * `model` for their provider request, while retaining the same override and
 * mode metadata for observability and delegation.
 */

import { CHAT_MODE_DEFAULTS } from '../config/model-defaults.mjs';

const MODE_ALIASES = Object.freeze({
    fast: 'fast',
    thinking: 'thinking',
    extra: 'extra_thinking',
    extra_thinking: 'extra_thinking',
    max: 'max_thinking',
    max_thinking: 'max_thinking',
});

function clean(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanOverrides(value) {
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value)
        .map(([role, model]) => [role, clean(model)])
        .filter(([, model]) => model));
}

export function resolveModelSelection({
    explicitModel = null,
    modelOverrides = {},
    modelMode = null,
    modelRoute = null,
    modeModels = {},
    profileModels = {},
    fallbackModel = null,
} = {}) {
    const overrides = cleanOverrides(modelOverrides);
    const rawExplicit = clean(explicitModel);
    const explicitMode = rawExplicit ? MODE_ALIASES[rawExplicit.toLowerCase()] : null;
    const explicit = explicitMode ? null : rawExplicit;
    const reasoningOverride = clean(overrides.reasoning);
    const requestedMode = MODE_ALIASES[clean(modelMode)?.toLowerCase()] || explicitMode || null;
    const profileReasoning = clean(profileModels.reasoning);
    const profileLocal = clean(profileModels.local);
    const modeModel = requestedMode
        ? clean(modeModels[requestedMode])
          || (requestedMode === 'fast' ? clean(profileModels.fast) : profileReasoning)
          || CHAT_MODE_DEFAULTS[requestedMode]
        : null;
    const model = explicit || reasoningOverride || modeModel || profileReasoning || profileLocal || clean(fallbackModel);

    return {
        model,
        modelOverride: explicit || reasoningOverride || null,
        modelOverrides: overrides,
        modelMode: requestedMode,
        modelRoute: clean(modelRoute),
    };
}

/** Add the shared selection fields to an /api/execute-style context. */
export function applyModelSelection(context, selection) {
    const next = { ...context };
    if (selection.modelOverride) next.model_override = selection.modelOverride;
    if (Object.keys(selection.modelOverrides || {}).length) next.model_overrides = selection.modelOverrides;
    if (selection.modelMode) next.model_mode = selection.modelMode;
    if (selection.modelRoute) next.model_route = selection.modelRoute;
    return next;
}
