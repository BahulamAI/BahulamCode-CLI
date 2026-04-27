import { NextResponse } from 'next/server'
import { readPlans } from '@/lib/claude-reader'

export const dynamic = 'force-dynamic'

export async function GET() {
  const plans = await readPlans()
  return NextResponse.json({ plans })
}
