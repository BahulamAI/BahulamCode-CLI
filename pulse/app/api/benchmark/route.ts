import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export const dynamic = 'force-dynamic'

interface BenchmarkResult {
  instance_id: string
  repo: string
  base_commit: string
  test_patch: string
  resolved: boolean
  test_result: {
    result: string[]
    exit_code: number
  }
  metadata: {
    agent_class: string
    model_name: string
    max_iterations: number
    eval_history: Array<{
      timestamp: string
      action: string
      observation: string
    }>
    submission: string
    instance_id: string
    predict_output: string
    model_patch: string
    test_result: {
      result: string[]
      exit_code: number
    }
  }
}

interface BenchmarkData {
  results: BenchmarkResult[]
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const run = searchParams.get('run') || 'swebench-v4-flash-300'
    const limit = parseInt(searchParams.get('limit') || '50', 10)
    const offset = parseInt(searchParams.get('offset') || '0', 10)

    // Load benchmark results from file
    const resultsPath = join(
      process.cwd(),
      '..',
      'benchmark',
      'results',
      'runs',
      run,
      'harness-results.json'
    )

    let data: BenchmarkData
    try {
      const fileContent = readFileSync(resultsPath, 'utf-8')
      data = JSON.parse(fileContent)
    } catch (error) {
      return NextResponse.json(
        { error: `Benchmark run "${run}" not found` },
        { status: 404 }
      )
    }

    // Calculate statistics
    const results = data.results || []
    const totalTests = results.length
    const resolvedTests = results.filter((r) => r.resolved).length
    const passRate = totalTests > 0 ? (resolvedTests / totalTests) * 100 : 0

    // Group by repo
    const byRepo = new Map<string, number>()
    const byRepoResolved = new Map<string, number>()
    for (const result of results) {
      const repo = result.repo || 'unknown'
      byRepo.set(repo, (byRepo.get(repo) || 0) + 1)
      if (result.resolved) {
        byRepoResolved.set(repo, (byRepoResolved.get(repo) || 0) + 1)
      }
    }

    // Paginate results
    const paginatedResults = results.slice(offset, offset + limit)

    return NextResponse.json({
      run,
      stats: {
        totalTests,
        resolvedTests,
        passRate: parseFloat(passRate.toFixed(2)),
        byRepo: Object.fromEntries(byRepo),
        byRepoResolved: Object.fromEntries(byRepoResolved),
      },
      pagination: {
        limit,
        offset,
        total: totalTests,
      },
      results: paginatedResults,
    })
  } catch (error) {
    console.error('Benchmark API error:', error)
    return NextResponse.json(
      { error: 'Failed to load benchmark data' },
      { status: 500 }
    )
  }
}
