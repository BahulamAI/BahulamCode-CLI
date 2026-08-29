import { NextResponse } from 'next/server'
import { readTodos } from '@/lib/claude-reader'

export const dynamic = 'force-dynamic'

export async function GET() {
  const todos = await readTodos()
  return NextResponse.json({ todos })
}
