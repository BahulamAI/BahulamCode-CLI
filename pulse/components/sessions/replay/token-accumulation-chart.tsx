'use client'

import { useMemo } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import { formatTokens, formatCost } from '@/lib/decode'
import type { ReplayTurn, CompactionEvent } from '@/types/claude'

interface Props {
  turns: ReplayTurn[]
  compactions: CompactionEvent[]
}

export function TokenAccumulationChart({ turns, compactions }: Props) {
  const data = useMemo(() => {
    const points: Array<{ turn: number; tokens: number; cost: number; label: string }> = []
    let cumCost = 0
    let cumTokens = 0
    let turnIdx = 0

    for (const t of turns) {
      turnIdx++
      if (t.type === 'assistant' && t.usage) {
        const u = t.usage
        cumTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
        cumCost += t.estimated_cost ?? 0
        points.push({ turn: turnIdx, tokens: cumTokens, cost: cumCost, label: `Turn ${turnIdx}` })
      }
    }
    return points
  }, [turns])

  const compactionTurnIndices = useMemo(
    () => compactions.map(c => c.turn_index),
    [compactions]
  )

  if (data.length === 0) return null

  return (
    <div className="border border-border rounded bg-card p-4">
      <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-3">
        📈 Token Accumulation per Turn
      </h3>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="turn"
            tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            label={{ value: 'Turn', position: 'insideBottom', offset: -2, fontSize: 9, fill: 'var(--muted-foreground)' }}
          />
          <YAxis
            tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatTokens}
            width={48}
          />
          <Tooltip
            contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}
            formatter={(val: number | undefined, name?: string) => [
              name === 'tokens' ? formatTokens(val ?? 0) : formatCost(val ?? 0),
              name === 'tokens' ? 'Context tokens' : 'Cumulative cost',
            ]}
          />
          {compactionTurnIndices.map(idx => (
            <ReferenceLine
              key={idx}
              x={idx}
              stroke="#f59e0b"
              strokeDasharray="4 2"
              label={{ value: '⚡', position: 'top', fontSize: 12 }}
            />
          ))}
          <Line
            type="monotone"
            dataKey="tokens"
            stroke="var(--viz-sky)"
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
