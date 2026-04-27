'use client'

import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import type { ProjectSummary } from '@/types/claude'
import { formatTokens } from '@/lib/decode'

interface Props {
  projects: ProjectSummary[]
}

/** Solid hex only — Recharts SVG `fill` does not resolve `var(--*)` reliably (shows as black). */
const PROJECT_COLORS = [
  '#d97706',
  '#16a34a',
  '#2563eb',
  '#ea580c',
  '#34d399',
  '#64748b',
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const { name, value } = payload[0]
  return (
    <div className="bg-card border border-border rounded px-3 py-2 text-[13px]">
      <p className="text-muted-foreground">{name}</p>
      <p className="text-foreground font-bold">{formatTokens(value)} tokens</p>
    </div>
  )
}

export function ProjectActivityDonut({ projects }: Props) {
  const totalTokens = projects.reduce(
    (s, p) => s + (p.input_tokens ?? 0) + (p.output_tokens ?? 0),
    0
  )

  const data = projects
    .slice(0, 5)
    .map((p) => ({
      name: p.display_name,
      value: (p.input_tokens ?? 0) + (p.output_tokens ?? 0),
    }))
    .filter((d) => d.value > 0)

  const othersTokens = totalTokens - data.reduce((s, d) => s + d.value, 0)
  if (othersTokens > 0) {
    data.push({ name: 'others', value: othersTokens })
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        no project data
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
          dataKey="value"
          strokeWidth={0}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PROJECT_COLORS[i % PROJECT_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
        <Legend
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 12 }}
          formatter={(value) => (
            <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>{value}</span>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}
