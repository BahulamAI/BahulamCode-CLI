/**
 * Remember Tool — persist a cross-session memory fact to the user's disk.
 *
 * CLI-local tool. The agent calls this when it wants to remember something
 * about the user, the project, or a preference. The fact lands in
 * ~/.bahulam/memory.md (global) or <cwd>/.bahulam/memory.md (project),
 * matching the disk-first CLI memory model (PRD-217).
 *
 * Contrast: chat / cloud-IDE / workspace surfaces continue writing to the
 * Supabase agent_memory table via the framework's SupabaseMemoryBackend.
 * Only CLI-originated requests use this local tool.
 *
 * The persisted shape round-trips 1:1 with the Supabase agent_memory
 * schema — see src/core/memory-disk.mjs for the file format and helpers.
 */

import { upsertFacts, loadDiskMemory, ensureBahulamDir } from '../core/memory-disk.mjs';

// Slug-safe generator when the caller didn't supply a fact_id. Prefer the
// caller's own id when they give one — that's how they update an existing
// fact instead of piling on near-duplicates.
function _makeFactId(hint) {
  const base = String(hint || 'fact').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const stamp = Math.floor(Date.now() / 1000).toString(36);
  return `${base || 'fact'}-${stamp}`;
}

export const RememberTool = {
    name: 'remember',
    description:
        'Save a cross-session memory fact to the user\'s disk (~/.bahulam/memory.md). ' +
        'Use when the user tells you a preference, when you learn a durable detail ' +
        'about their project, or when the current turn establishes a decision worth ' +
        'carrying forward. Do NOT use for ephemeral session state (that belongs in ' +
        'the current conversation) or for temporary task tracking (use TodoWrite).',
    inputSchema: {
        type: 'object',
        properties: {
            content: {
                type: 'string',
                description:
                    'The fact to remember, in prose. One or a few sentences. ' +
                    'Include enough context to be useful without the surrounding conversation.',
            },
            fact_type: {
                type: 'string',
                enum: ['preference', 'entity', 'decision', 'context', 'other'],
                description:
                    'Category. `preference` = user always/never wants X. `entity` = ' +
                    'thing/person/service (their company, their stack, their env). ' +
                    '`decision` = choice made this session worth remembering. ' +
                    '`context` = ongoing situation the agent should know next turn. ' +
                    '`other` = anything else.',
            },
            fact_id: {
                type: 'string',
                description:
                    'Stable ID. Reuse the same id to UPDATE a prior fact (in-place ' +
                    'overwrite). Auto-generated from `content` if omitted, so ' +
                    'auto-generated ids create new rows every time — pass an ' +
                    'explicit id for anything you might want to update later.',
            },
            memory_scope: {
                type: 'string',
                enum: ['global', 'project'],
                description:
                    '`global` (default) writes to ~/.bahulam/memory.md — visible ' +
                    'across every session. `project` writes to ' +
                    '<cwd>/.bahulam/memory.md and only surfaces when running in ' +
                    'this project. Use `project` for facts tied to this specific ' +
                    'codebase (its architecture, its conventions, its history).',
            },
            confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description:
                    '0..1. How sure are you this fact is durably true? Use 0.9+ ' +
                    'when the user stated it explicitly. Use 0.5-0.7 for inferred ' +
                    'facts. Below 0.5 usually isn\'t worth saving.',
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Short lowercase labels (e.g. ["performance", "cache"]). ' +
                    'Help future turns retrieve related facts.',
            },
        },
        required: ['content'],
    },

    validateInput(input) {
        const errs = [];
        if (!input || typeof input.content !== 'string' || !input.content.trim()) {
            errs.push('content is required and must be a non-empty string');
        }
        if (input.confidence != null) {
            const n = Number(input.confidence);
            if (!Number.isFinite(n) || n < 0 || n > 1) errs.push('confidence must be a number in [0, 1]');
        }
        return errs;
    },

    async call(input, _options = {}) {
        const now = new Date().toISOString();
        const scope = input.memory_scope === 'project' ? 'project' : 'global';
        const fact = {
            fact_id: (input.fact_id || _makeFactId(input.content)).trim(),
            content: String(input.content).trim(),
            fact_type: input.fact_type || 'other',
            confidence: typeof input.confidence === 'number' ? input.confidence : 0.8,
            source: 'agent',
            tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
            metadata: {},
            project_id: null,
            memory_scope: scope,
            created_at: now,
            updated_at: now,
        };

        // Preserve created_at if we're updating an existing fact.
        const existing = loadDiskMemory().find(f => f.fact_id === fact.fact_id);
        if (existing?.created_at) fact.created_at = existing.created_at;

        try {
            // Belt-and-braces: upsertFacts also mkdir's, but a stale cwd on
            // a project write could still miss the parent — do it explicitly.
            ensureBahulamDir(scope);
            upsertFacts([fact]);
        } catch (err) {
            return {
                success: false,
                output: `remember failed: ${err?.message || err}`,
                _tool: 'remember',
            };
        }
        return {
            success: true,
            output: `Saved ${scope} fact '${fact.fact_id}' (${fact.content.length} chars).`,
            _tool: 'remember',
            _fact_id: fact.fact_id,
            _scope: scope,
        };
    },
};
