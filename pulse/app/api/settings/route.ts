import { NextResponse } from 'next/server'
import { readSettings, getClaudeStorageBytes, readSkills, readInstalledPlugins } from '@/lib/claude-reader'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [settings, storageBytes, skills, plugins] = await Promise.all([
    readSettings(),
    getClaudeStorageBytes(),
    readSkills(),
    readInstalledPlugins(),
  ])
  return NextResponse.json({ settings, storageBytes, skills, plugins })
}
