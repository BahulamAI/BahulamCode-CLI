'use client'

import { TrendingUp, TrendingDown } from 'lucide-react'
import { LineChart, Line, ResponsiveContainer } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useTheme } from '@/components/theme-provider'

interface StatCardProps {
  title: string
  value: string
  description?: string
  /** Percentage change vs previous period: positive = up, negative = down */
  trend?: number
  /** Raw values for sparkline (last N days) */
  sparkData?: number[]
  accentColor?: string
}

/** Recharts sets SVG stroke/fill from strings; `var(--*)` often does not resolve on SVG → black. */
function resolveChartColor(accentColor: string | undefined, theme: 'light' | 'dark'): string {
  if (!accentColor) return theme === 'light' ? '#f97316' : '#d97706'
  switch (accentColor) {
    case 'var(--viz-sky)':
      return theme === 'light' ? '#1d4ed8' : '#60a5fa'
    case 'var(--foreground)':
      return theme === 'light' ? '#18181b' : '#e8eaed'
    default:
      return accentColor
  }
}

export function StatCard({ title, value, description, trend, sparkData, accentColor }: StatCardProps) {
  const { theme } = useTheme()
  const resolvedAccent = resolveChartColor(accentColor, theme)
  const hasTrend = trend !== undefined && !isNaN(trend)
  const isUp = hasTrend && trend! >= 0
  const trendColor = hasTrend
    ? isUp
      ? theme === 'light'
        ? '#059669'
        : '#34d399'
      : theme === 'light'
        ? '#dc2626'
        : '#f87171'
    : undefined
  const rawSpark = sparkData ?? []
  // Single point does not draw a line in Recharts; duplicate for a flat segment.
  const chartData =
    rawSpark.length === 1
      ? [{ v: rawSpark[0]! }, { v: rawSpark[0]! }]
      : rawSpark.map(v => ({ v }))

  return (
    <Card className="gap-3">
      <CardHeader className="pb-0">
        <CardDescription className="text-sm font-medium">{title}</CardDescription>
        <div className="flex items-end justify-between mt-1">
          <CardTitle
            className="text-3xl font-bold tabular-nums leading-none"
            style={{ color: resolvedAccent }}
          >
            {value}
          </CardTitle>
          {hasTrend && (
            <Badge
              variant="outline"
              className="gap-1 text-xs font-medium"
              style={{
                color: trendColor,
                borderColor: `${trendColor}40`,
                backgroundColor: `${trendColor}12`,
              }}
            >
              {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {Math.abs(trend!).toFixed(1)}%
            </Badge>
          )}
        </div>
        {description && (
          <CardDescription className="text-xs mt-1">{description}</CardDescription>
        )}
      </CardHeader>
      {chartData.length > 0 && (
        <CardContent className="pt-0 pb-4 px-6">
          <ResponsiveContainer width="100%" height={48}>
            <LineChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <Line
                type="monotone"
                dataKey="v"
                stroke={resolvedAccent}
                strokeWidth={1.5}
                dot={false}
                strokeOpacity={0.7}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      )}
    </Card>
  )
}
