import { NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { readMemories } from '@/lib/claude-reader'

export const dynamic = 'force-dynamic'

const CLAUDE_DIR = path.join(os.homedir(), '.orca')

export async function GET() {
  const memories = await readMemories()
  return NextResponse.json({ memories })
}

export async function PATCH(req: Request) {
  try {
    const { projectSlug, file, content } = await req.json() as {
      projectSlug?: string
      file?: string
      content?: string
    }

    if (!projectSlug || !file || typeof content !== 'string') {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Only allow .md files
    if (!file.endsWith('.md')) {
      return NextResponse.json({ error: 'Only .md files allowed' }, { status: 400 })
    }

    // Prevent path traversal — slug and file must be plain names (no slashes or dots)
    if (/[/\\]/.test(projectSlug) || /[/\\]/.test(file)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }

    const filePath = path.join(CLAUDE_DIR, 'projects', projectSlug, 'memory', file)

    // Ensure the resolved path stays within ~/.orca/projects/
    const allowedRoot = path.join(CLAUDE_DIR, 'projects')
    if (!filePath.startsWith(allowedRoot + path.sep)) {
      return NextResponse.json({ error: 'Path outside allowed directory' }, { status: 403 })
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
