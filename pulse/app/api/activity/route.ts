import { NextResponse } from 'next/server'
import { getSessions, readStatsCache } from '@/lib/claude-reader'
import type { DailyActivity, SessionMeta } from '@/types/claude'

export const dynamic = 'force-dynamic'

function computeStreaks(dates: Set<string>): { current: number; longest: number } {
  const sorted = [...dates].sort()
  if (sorted.length === 0) return { current: 0, longest: 0 }

  let longest = 1
  let streak = 1
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1])
    const curr = new Date(sorted[i])
    const diff = (curr.getTime() - prev.getTime()) / 86_400_000
    if (diff === 1) {
      streak++
      if (streak > longest) longest = streak
    } else {
      streak = 1
    }
  }

  // Current streak (from today backwards)
  const today = new Date().toISOString().slice(0, 10)
  let current = 0
  const d = new Date(today)
  while (dates.has(d.toISOString().slice(0, 10))) {
    current++
    d.setDate(d.getDate() - 1)
  }

  return { current, longest }
}

function computeDailyActivityFromSessions(sessions: SessionMeta[]): DailyActivity[] {
  const byDate = new Map<string, { messages: number; sessions: number; tools: number }>()

  for (const s of sessions) {
    if (!s.start_time) continue
    const date = s.start_time.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue

    const existing = byDate.get(date) ?? { messages: 0, sessions: 0, tools: 0 }
    existing.messages += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
    existing.sessions += 1
    existing.tools += Object.values(s.tool_counts ?? {}).reduce((sum, count) => sum + count, 0)
    byDate.set(date, existing)
  }

  return Array.from(byDate.entries())
    .map(([date, { messages, sessions: sessionCount, tools }]) => ({
      date,
      messageCount: messages,
      sessionCount,
      toolCallCount: tools,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function mergeDailyActivity(fromStats: DailyActivity[], fromSessions: DailyActivity[]): DailyActivity[] {
  const byDate = new Map<string, DailyActivity>()
  for (const d of fromStats) byDate.set(d.date, d)
  for (const d of fromSessions) byDate.set(d.date, d)
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
}

function computeHourCounts(sessions: SessionMeta[]): Array<{ hour: number; count: number }> {
  const hourCounts = Array.from({ length: 24 }, () => 0)

  for (const s of sessions) {
    if (s.user_message_timestamps?.length) {
      for (const ts of s.user_message_timestamps) {
        const d = new Date(ts)
        if (!isNaN(d.getTime())) hourCounts[d.getHours()]++
      }
      continue
    }

    if (s.message_hours?.length) {
      for (const hour of s.message_hours) {
        if (Number.isInteger(hour) && hour >= 0 && hour < 24) hourCounts[hour]++
      }
      continue
    }

    const d = new Date(s.start_time)
    if (!isNaN(d.getTime())) hourCounts[d.getHours()]++
  }

  return hourCounts.map((count, hour) => ({ hour, count }))
}

export async function GET() {
  const [stats, sessions] = await Promise.all([readStatsCache(), getSessions()])
  const dailyFromSessions = computeDailyActivityFromSessions(sessions)
  const dailyActivity = stats
    ? mergeDailyActivity(stats.dailyActivity ?? [], dailyFromSessions)
    : dailyFromSessions

  // Day-of-week counts from session timestamps
  const dowCounts: number[] = [0, 0, 0, 0, 0, 0, 0] // Sun=0..Sat=6
  const activeDates = new Set<string>()

  for (const s of sessions) {
    if (!s.start_time) continue
    const d = new Date(s.start_time)
    if (isNaN(d.getTime())) continue
    dowCounts[d.getDay()]++
    activeDates.add(s.start_time.slice(0, 10))
  }

  const streaks = computeStreaks(activeDates)

  // Most active day
  let mostActiveDay = ''
  let mostActiveMsgs = 0
  for (const da of dailyActivity) {
    if (da.messageCount > mostActiveMsgs) {
      mostActiveMsgs = da.messageCount
      mostActiveDay = da.date
    }
  }

  return NextResponse.json({
    daily_activity: dailyActivity,
    hour_counts: computeHourCounts(sessions),
    dow_counts: dowCounts.map((count, i) => ({
      day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i],
      count,
    })),
    streaks,
    most_active_day: mostActiveDay,
    most_active_day_msgs: mostActiveMsgs,
    total_active_days: activeDates.size,
  })
}
