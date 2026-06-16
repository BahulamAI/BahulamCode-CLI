import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'

interface BenchmarkResult {
  instance_id: string
  repo: string
  model: string
  timestamp: string
  kepler: {
    status: string
    exit_code: number
    duration_seconds: number
    tokens_used: number
    cost: number
    tool_calls: number
    sub_agents: string[]
  }
  patch_lines: number
  model_patch: string
  status: string
}

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

async function loadBenchmarkResults(): Promise<BenchmarkResult[]> {
  try {
    const resultsPath = path.join(
      process.cwd(),
      'benchmark/results/runs/swebench-v4-flash-300/harness-results.json'
    )

    if (!fs.existsSync(resultsPath)) {
      return []
    }

    const data = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'))
    return data.results || []
  } catch (error) {
    console.error('Error loading benchmark results:', error)
    return []
  }
}

function calculateStats(results: BenchmarkResult[]): BenchmarkStats {
  if (results.length === 0) {
    return {
      total_runs: 0,
      passed: 0,
      failed: 0,
      error: 0,
      success_rate: 0,
      avg_duration: 0,
      total_cost: 0,
      total_tokens: 0,
      avg_tokens_per_run: 0,
      by_status: {},
      by_repo: {},
      by_model: {},
    }
  }

  const by_status: Record<string, number> = {}
  const by_repo: Record<string, { count: number; passed: number }> = {}
  const by_model: Record<string, { count: number; passed: number }> = {}

  let total_cost = 0
  let total_tokens = 0
  let total_duration = 0
  let passed = 0

  results.forEach((result) => {
    // Count by status
    by_status[result.status] = (by_status[result.status] || 0) + 1

    // Count by repo
    if (!by_repo[result.repo]) {
      by_repo[result.repo] = { count: 0, passed: 0 }
    }
    by_repo[result.repo].count++

    // Count by model
    if (!by_model[result.model]) {
      by_model[result.model] = { count: 0, passed: 0 }
    }
    by_model[result.model].count++

    // Aggregate metrics
    if (result.kepler) {
      total_cost += result.kepler.cost || 0
      total_tokens += result.kepler.tokens_used || 0
      total_duration += result.kepler.duration_seconds || 0

      if (result.kepler.status === 'success') {
        passed++
        by_repo[result.repo].passed++
        by_model[result.model].passed++
      }
    }
  })

  // Calculate success rates
  const by_repo_with_rates = Object.entries(by_repo).reduce(
    (acc, [repo, data]) => {
      acc[repo] = {
        ...data,
        success_rate: data.count > 0 ? (data.passed / data.count) * 100 : 0,
      }
      return acc
    },
    {} as Record<string, { count: number; passed: number; success_rate: number }>
  )

  const by_model_with_rates = Object.entries(by_model).reduce(
    (acc, [model, data]) => {
      acc[model] = {
        ...data,
        success_rate: data.count > 0 ? (data.passed / data.count) * 100 : 0,
      }
      return acc
    },
    {} as Record<string, { count: number; passed: number; success_rate: number }>
  )

  return {
    total_runs: results.length,
    passed,
    failed: by_status['failed'] || 0,
    error: by_status['error'] || 0,
    success_rate: (passed / results.length) * 100,
    avg_duration: total_duration / results.length,
    total_cost,
    total_tokens,
    avg_tokens_per_run: total_tokens / results.length,
    by_status,
    by_repo: by_repo_with_rates,
    by_model: by_model_with_rates,
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const format = searchParams.get('format') || 'summary'
  const repo = searchParams.get('repo')
  const model = searchParams.get('model')
  const status = searchParams.get('status')

  const results = await loadBenchmarkResults()

  // Filter results
  let filtered = results
  if (repo) {
    filtered = filtered.filter((r) => r.repo === repo)
  }
  if (model) {
    filtered = filtered.filter((r) => r.model === model)
  }
  if (status) {
    filtered = filtered.filter((r) => r.status === status)
  }

  if (format === 'detailed') {
    return NextResponse.json({
      results: filtered,
      count: filtered.length,
    })
  }

  // Default: summary format
  const stats = calculateStats(filtered)

  return NextResponse.json({
    stats,
    filters: {
      repo: repo || null,
      model: model || null,
      status: status || null,
    },
  })
}
