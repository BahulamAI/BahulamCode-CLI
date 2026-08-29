'use client'

import Link from 'next/link'
import { formatCost, formatDuration, formatRelativeDate } from '@/lib/decode'
import { categoryColorMix, toolBarColor } from '@/lib/tool-categories'
import type { ProjectSummary } from '@/types/claude'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Clock, MessageSquare, GitBranch, Plug, Bot } from 'lucide-react'

const LANG_COLORS: Record<string, string> = {
  TypeScript:  'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/25',
  JavaScript:  'bg-yellow-400/10 text-yellow-700 dark:text-yellow-400 border-yellow-400/30',
  Python:      'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/25',
  Rust:        'bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/25',
  Go:          'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/25',
  Java:        'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/25',
  'C++':       'bg-pink-500/10 text-pink-700 dark:text-pink-400 border-pink-500/25',
  C:           'bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/25',
  'C#':        'bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/25',
  Ruby:        'bg-red-400/10 text-red-600 dark:text-red-400 border-red-400/25',
  PHP:         'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/25',
  Swift:       'bg-orange-400/10 text-orange-600 dark:text-orange-400 border-orange-400/25',
  Kotlin:      'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/25',
  CSS:         'bg-blue-700/10 dark:bg-sky-500/10 text-blue-700 dark:text-sky-400 border-blue-700/25 dark:border-sky-500/25',
  HTML:        'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/25',
  Shell:       'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  Bash:        'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  Markdown:    'bg-gray-400/10 text-gray-600 dark:text-gray-400 border-gray-400/25',
  JSON:        'bg-amber-400/10 text-amber-700 dark:text-amber-400 border-amber-400/25',
  YAML:        'bg-lime-500/10 text-lime-700 dark:text-lime-500 border-lime-500/25',
}

const FALLBACK_PALETTE = [
  'bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/25',
  'bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-500/25',
  'bg-lime-500/10 text-lime-700 dark:text-lime-400 border-lime-500/25',
  'bg-blue-700/10 dark:bg-sky-600/10 text-blue-700 dark:text-sky-400 border-blue-700/25 dark:border-sky-600/25',
  'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/25',
  'bg-amber-600/10 text-amber-700 dark:text-amber-400 border-amber-600/25',
]

function langColor(lang: string): string {
  if (LANG_COLORS[lang]) return LANG_COLORS[lang]
  let hash = 0
  for (let i = 0; i < lang.length; i++) hash = (hash * 31 + lang.charCodeAt(i)) >>> 0
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length]
}

export function ProjectCard({ project }: { project: ProjectSummary }) {
  const topTools = Object.entries(project.tool_counts ?? {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
  const maxToolCount = topTools[0]?.[1] ?? 1

  const topLangs = Object.entries(project.languages ?? {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)

  return (
    <Link href={`/projects/${project.slug}`} className="block group">
      <Card className="h-full gap-0 py-0 hover:border-primary/40 transition-colors overflow-hidden">
        <CardHeader className="px-4 pt-4 pb-3 gap-2">
          {/* Title row */}
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors truncate leading-snug">
              {project.display_name}
            </h3>
            <span className="text-[11px] text-muted-foreground/60 whitespace-nowrap shrink-0 mt-0.5">
              {formatRelativeDate(project.last_active)}
            </span>
          </div>

          {/* Path */}
          <p className="text-[11px] text-muted-foreground/50 font-mono truncate -mt-1">
            {project.project_path}
          </p>

          {/* Language + feature badges */}
          <div className="flex flex-wrap gap-1.5">
            {topLangs.map(([lang]) => (
              <Badge key={lang} variant="outline" className={`text-[11px] px-1.5 py-0 h-5 ${langColor(lang)}`}>
                {lang}
              </Badge>
            ))}
            {project.uses_mcp && (
              <Badge variant="outline" className="text-[11px] px-1.5 py-0 h-5 bg-blue-500/10 text-blue-500 border-blue-500/20 gap-1">
                <Plug className="w-2.5 h-2.5" /> MCP
              </Badge>
            )}
            {project.uses_task_agent && (
              <Badge variant="outline" className="text-[11px] px-1.5 py-0 h-5 bg-purple-500/10 text-purple-500 border-purple-500/20 gap-1">
                <Bot className="w-2.5 h-2.5" /> Agent
              </Badge>
            )}
            {project.branches.length > 0 && (
              <>
                <span
                  className="h-4 w-px shrink-0 self-center bg-border/50"
                  aria-hidden
                />
                <GitBranch className="h-3 w-3 shrink-0 self-center text-muted-foreground/45" aria-hidden />
                {project.branches.slice(0, 3).map(b => (
                  <Badge
                    key={b}
                    variant="outline"
                    className="h-5 max-w-28 truncate border-border/50 px-1.5 py-0 font-mono text-[11px] text-muted-foreground/80"
                    title={b}
                  >
                    {b}
                  </Badge>
                ))}
                {project.branches.length > 3 && (
                  <span className="self-center text-[11px] text-muted-foreground/45">
                    +{project.branches.length - 3}
                  </span>
                )}
              </>
            )}
          </div>
        </CardHeader>

        <CardContent className="px-4 pb-4 space-y-3">
          {/* Stats row */}
          <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <MessageSquare className="w-3 h-3" />
              {project.session_count} sessions
            </span>
            <span className="text-border">·</span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDuration(project.total_duration_minutes)}
            </span>
            {(project.total_lines_added ?? 0) > 0 && (
              <>
                <span className="text-border">·</span>
                <span className="text-emerald-500 font-mono">+{project.total_lines_added.toLocaleString()}</span>
                <span className="text-red-400 font-mono">-{project.total_lines_removed.toLocaleString()}</span>
              </>
            )}
          </div>

          {/* Tool bar chart */}
          {topTools.length > 0 && (
            <div className="space-y-1">
              {topTools.map(([tool, count]) => {
                const color = toolBarColor(tool)
                const width = Math.max(8, Math.round((count / maxToolCount) * 100))
                return (
                  <div key={tool} className="flex items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground/50 w-16 truncate">{tool}</span>
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${width}%`, backgroundColor: categoryColorMix(color, 58) }}
                      />
                    </div>
                    <span className="text-muted-foreground/40 w-7 text-right tabular-nums">{count}</span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Cost footer */}
          <div className="flex items-center justify-between pt-2 border-t border-border/30">
            <span className="text-[11px] text-muted-foreground/50">Est. cost</span>
            <span className="text-sm font-bold text-primary tabular-nums">{formatCost(project.estimated_cost)}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
