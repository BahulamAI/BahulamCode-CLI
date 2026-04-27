'use client'

import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { useTheme } from '@/components/theme-provider'

interface Props {
  hourCounts: Record<string, number>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const hour = parseInt(label)
  const period = hour < 12 ? 'AM' : 'PM'
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 text-[13px]">
      <p className="text-muted-foreground">{h12}:00 {period}</p>
      <p className="text-primary font-bold">{payload[0].value} sessions</p>
    </div>
  )
}

export function PeakHoursChart({ hourCounts }: Props) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  const data = Array.from({ length: 24 }, (_, i) => ({
    hour: String(i),
    count: hourCounts[String(i)] ?? 0,
  }))

  const sorted = [...data].sort((a, b) => b.count - a.count)
  const top3Hours = new Set(sorted.slice(0, 3).map(d => d.hour))

  // Light mode: bright amber for top, soft amber for rest
  // Dark mode: keep the original darker tones
  const topFill    = isDark ? '#d97706' : '#f59e0b'
  const normalFill = isDark ? '#78350f' : '#fde68a'
  const strokeColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.4)'

  return (
    <div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="hour"
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => {
              const h = parseInt(v)
              if (h === 0) return '12a'
              if (h === 12) return '12p'
              if (h < 12) return `${h}a`
              return `${h - 12}p`
            }}
          />
          <YAxis hide />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(180,83,9,0.08)' }} />
          <Bar dataKey="count" radius={[2, 2, 0, 0]} maxBarSize={14}
               stroke={strokeColor} strokeWidth={0.75}>
            {data.map(d => (
              <Cell
                key={d.hour}
                fill={top3Hours.has(d.hour) ? topFill : normalFill}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="text-[11px] font-mono text-muted-foreground/60 mt-1">
        top 3 peak hours highlighted
      </p>
    </div>
  )
}
