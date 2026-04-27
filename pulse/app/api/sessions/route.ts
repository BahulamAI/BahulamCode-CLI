import path from 'path'
import { NextResponse } from 'next/server'
import {
  getSessions,
  readAllSessionMeta,
  readAllFacets,
  listProjectSlugs,
  listProjectJSONLFiles,
  readJSONLLines,
} from '@/lib/claude-reader'
import { estimateCostFromUsage } from '@/lib/pricing'
import type { SessionWithFacet } from '@/types/claude'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLine = Record<string, any>

async function enrichSessions(sessions: { session_id: string }[]) {
  // Build a map of sessionId -> { slug, version, gitBranch, has_compaction, has_thinking }
  const enrichment: Record<string, {
    slug?: string
    version?: string
    git_branch?: string
    has_compaction?: boolean
    has_thinking?: boolean
  }> = {}

  const slugs = await listProjectSlugs()
  await Promise.all(
    slugs.map(async (slug) => {
      const files = await listProjectJSONLFiles(slug)
      await Promise.all(
        files.map(async (f) => {
          const sessionId = path.basename(f, '.jsonl')
          const data: {
            slug?: string; version?: string; gitBranch?: string
            has_compaction?: boolean; has_thinking?: boolean
          } = {}

          await readJSONLLines(f, (line: AnyLine) => {
            if (!data.slug && line.slug)         data.slug = line.slug
            if (!data.version && line.version)   data.version = line.version
            if (!data.gitBranch && line.gitBranch && line.gitBranch !== 'HEAD') {
              data.gitBranch = line.gitBranch
            }
            if (line.type === 'system' && line.subtype === 'compact_boundary') {
              data.has_compaction = true
            }
            if (line.type === 'assistant' && Array.isArray(line.message?.content)) {
              if (line.message.content.some((c: AnyLine) => c.type === 'thinking')) {
                data.has_thinking = true
              }
            }
          })

          enrichment[sessionId] = {
            slug: data.slug,
            version: data.version,
            git_branch: data.gitBranch,
            has_compaction: data.has_compaction,
            has_thinking: data.has_thinking,
          }
        })
      )
    })
  )
  return enrichment
}

export async function GET() {
  const [sessions, metaSessions, facets] = await Promise.all([
    getSessions(),
    readAllSessionMeta(),
    readAllFacets(),
  ])
  const metaMap = new Map(metaSessions.map((s) => [s.session_id, s]))
  const merged = sessions.map((s) => {
    const meta = metaMap.get(s.session_id)
    if (meta) return { ...meta, ...s } as typeof s
    return s
  })
  const enrichment = await enrichSessions(merged)

  const facetMap = new Map(facets.map(f => [f.session_id, f]))

  const result: SessionWithFacet[] = merged.map(s => {
    const facet = facetMap.get(s.session_id)
    const enrich = enrichment[s.session_id] ?? {}

    // Estimate cost from session tokens (rough: treat all as opus)
    const estimated_cost = estimateCostFromUsage('claude-opus-4-6', {
      input_tokens: s.input_tokens ?? 0,
      output_tokens: s.output_tokens ?? 0,
      cache_creation_input_tokens: s.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: s.cache_read_input_tokens ?? 0,
    })

    return {
      ...s,
      facet,
      estimated_cost,
      slug: enrich.slug,
      version: enrich.version,
      git_branch: enrich.git_branch,
      has_compaction: enrich.has_compaction ?? false,
      has_thinking: enrich.has_thinking ?? false,
    }
  })

  return NextResponse.json({ sessions: result, total: result.length })
}
