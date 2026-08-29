'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface BenchmarkStats {
  total_runs: number
  passed: number
  failed: number
  error: number
  success_rate: number
  avg_duration: number
  total_cost: number
  total_tokens: number
  avg_tokens_per_run: number
  by_status: Record<string, number>
  by_repo: Record<string, { count: number; passed: number; success_rate: number }>
  by_model: Record<string, { count: number; passed: number; success_rate: number }>
}

interface BenchmarkResponse {
  stats: BenchmarkStats
  filters: {
    repo: string | null
    model: string | null
    status: string | null
  }
}

export default function BenchmarksPage() {
  const [data, setData] = useState<BenchmarkResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchBenchmarks = async () => {
      try {
        const response = await fetch('/api/benchmarks')
        if (!response.ok) {
          throw new Error('Failed to fetch benchmarks')
        }
        const json = await response.json()
        setData(json)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchBenchmarks()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading benchmarks...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-destructive">Error: {error}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">No benchmark data available</p>
      </div>
    )
  }

  const stats = data.stats

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Benchmarks</h1>
        <p className="text-muted-foreground mt-2">SWE-Bench v4 Flash 300 Results</p>
      </div>

      {/* Key Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total_runs}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.success_rate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.passed} passed, {stats.failed} failed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${stats.total_cost.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.avg_tokens_per_run.toFixed(0)} tokens/run
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Avg Duration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.avg_duration.toFixed(1)}s</div>
            <p className="text-xs text-muted-foreground mt-1">
              {(stats.total_tokens / 1000).toFixed(1)}K tokens total
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Status Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Status Breakdown</CardTitle>
          <CardDescription>Distribution of run statuses</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Object.entries(stats.by_status).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      status === 'success'
                        ? 'default'
                        : status === 'failed'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {status}
                  </Badge>
                  <span className="text-sm text-muted-foreground">{count} runs</span>
                </div>
                <span className="text-sm font-medium">
                  {((count / stats.total_runs) * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* By Repository */}
      <Card>
        <CardHeader>
          <CardTitle>Performance by Repository</CardTitle>
          <CardDescription>Success rate and run count per repository</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Object.entries(stats.by_repo)
              .sort((a, b) => b[1].count - a[1].count)
              .map(([repo, data]) => (
                <div key={repo} className="flex items-center justify-between border-b pb-3 last:border-0">
                  <div>
                    <p className="font-medium text-sm">{repo}</p>
                    <p className="text-xs text-muted-foreground">
                      {data.count} runs, {data.passed} passed
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-sm">{data.success_rate.toFixed(1)}%</p>
                  </div>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>

      {/* By Model */}
      <Card>
        <CardHeader>
          <CardTitle>Performance by Model</CardTitle>
          <CardDescription>Success rate and run count per model</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Object.entries(stats.by_model)
              .sort((a, b) => b[1].count - a[1].count)
              .map(([model, data]) => (
                <div key={model} className="flex items-center justify-between border-b pb-3 last:border-0">
                  <div>
                    <p className="font-medium text-sm">{model}</p>
                    <p className="text-xs text-muted-foreground">
                      {data.count} runs, {data.passed} passed
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-sm">{data.success_rate.toFixed(1)}%</p>
                  </div>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
