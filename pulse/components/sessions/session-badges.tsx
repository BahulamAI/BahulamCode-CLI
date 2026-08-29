'use client'

interface BadgeProps {
  has_compaction?: boolean
  uses_task_agent?: boolean
  uses_mcp?: boolean
  uses_web_search?: boolean
  uses_web_fetch?: boolean
  has_thinking?: boolean
}

export function SessionBadges({
  has_compaction,
  uses_task_agent,
  uses_mcp,
  uses_web_search,
  uses_web_fetch,
  has_thinking,
}: BadgeProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {has_compaction && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[12px] font-medium bg-amber-500/20 text-amber-400 border border-amber-500/30">
          ⚡ compacted
        </span>
      )}
      {uses_task_agent && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[12px] font-medium bg-purple-500/20 text-purple-400 border border-purple-500/30">
          🤖 agent
        </span>
      )}
      {uses_mcp && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[12px] font-medium bg-blue-500/20 text-blue-700 dark:text-blue-400 border border-blue-500/30">
          🔌 mcp
        </span>
      )}
      {(uses_web_search || uses_web_fetch) && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[12px] font-medium bg-green-500/20 text-green-400 border border-green-500/30">
          🔍 web
        </span>
      )}
      {has_thinking && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[12px] font-medium bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
          🧠 thinking
        </span>
      )}
    </div>
  )
}
