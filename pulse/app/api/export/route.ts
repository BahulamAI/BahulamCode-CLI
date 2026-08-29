import { NextResponse } from 'next/server'
import { readStatsCache, getSessions, readAllFacets, readHistory } from '@/lib/claude-reader'
import type { ExportPayload, Facet, SessionMeta } from '@/types/claude'

export const dynamic = 'force-dynamic'

function filterSessionsByDateRange(
  sessions: SessionMeta[],
  dateRange?: { from?: string; to?: string }
) {
  const fromMs = dateRange?.from ? new Date(dateRange.from).getTime() : null
  const toMs = dateRange?.to ? new Date(dateRange.to + 'T23:59:59.999Z').getTime() : null
  return sessions.filter(s => {
    if (!s.start_time) return true
    const t = new Date(s.start_time).getTime()
    if (fromMs !== null && t < fromMs) return false
    if (toMs !== null && t > toMs) return false
    return true
  })
}

function facetsForSessions(facets: Facet[], sessions: SessionMeta[]) {
  const sessionIds = new Set(sessions.map(s => s.session_id))
  return facets.filter(f => sessionIds.has(f.session_id))
}

/** Preview counts for the export UI (optional date filter via query params). */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const from = url.searchParams.get('from') || undefined
  const to = url.searchParams.get('to') || undefined
  const dateRange = from || to ? { from, to } : undefined

  const [stats, sessions, facets, history] = await Promise.all([
    readStatsCache(),
    getSessions(),
    readAllFacets(),
    readHistory(10_000),
  ])

  const filteredSessions = filterSessionsByDateRange(sessions, dateRange)
  const filteredFacets = facetsForSessions(facets, filteredSessions)

  return NextResponse.json({
    sessionCount: filteredSessions.length,
    facetCount: filteredFacets.length,
    historyEntries: history.length,
    hasStatsCache: stats !== null,
    totalSessionsIndexed: sessions.length,
  })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { dateRange } = body as { dateRange?: { from?: string; to?: string } }

  const [stats, sessions, facets, history] = await Promise.all([
    readStatsCache(),
    getSessions(),
    readAllFacets(),
    readHistory(10_000),
  ])

  const filteredSessions = filterSessionsByDateRange(sessions, dateRange)
  const filteredFacets = facetsForSessions(facets, filteredSessions)

  const payload: ExportPayload = {
    exportedAt: new Date().toISOString(),
    version: '1.0.0',
    stats,
    sessions: filteredSessions,
    facets: filteredFacets,
    history,
  }

  return NextResponse.json(payload)
}
