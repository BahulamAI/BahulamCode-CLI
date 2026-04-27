'use client'

import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ResponsiveContainer } from 'recharts'
import { formatCost } from '@/lib/decode'
import type { ProjectCost } from '@/types/claude'

interface Props {
  projects: ProjectCost[]
}

export function CostByProjectChart({ projects }: Props) {
  const top = projects.slice(0, 12)

  return (
    <div>
      <h3 className="text-[13px] font-bold text-muted-foreground uppercase tracking-widest mb-3">Cost by Project</h3>
      <ResponsiveContainer width="100%" height={Math.max(120, top.length * 28)}>
        <BarChart data={top} layout="vertical" margin={{ top: 0, right: 60, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `$${v.toFixed(2)}`}
          />
          <YAxis
            type="category"
            dataKey="display_name"
            tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={90}
          />
          <Tooltip
            contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}
            formatter={(val: number | undefined) => [formatCost(val ?? 0), 'Estimated cost']}
          />
          <Bar dataKey="estimated_cost" radius={[0, 3, 3, 0]}>
            {top.map((_, i) => (
              <Cell key={i} fill={i === 0 ? '#d97706' : '#d97706' + Math.max(30, 100 - i * 7).toString(16)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
