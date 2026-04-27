import type { CompactionEvent } from '@/types/claude'
import { formatTokens } from '@/lib/decode'

export function CompactionCard({ event }: { event: CompactionEvent }) {
  return (
    <div className="my-3 border border-amber-500/40 bg-amber-500/10 rounded-lg px-4 py-3">
      <div className="flex items-center gap-2 text-amber-400 text-sm font-bold mb-1">
        <span>⚡</span>
        <span>CONTEXT COMPACTION</span>
        <span className="ml-auto text-amber-500/70 font-normal">
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
      </div>
      <div className="flex gap-4 text-sm text-amber-300/80">
        <span>trigger: <span className="text-amber-300 font-medium">{event.trigger}</span></span>
        <span>context before: <span className="text-amber-300 font-medium">{formatTokens(event.pre_tokens)} tokens</span></span>
      </div>
      {event.summary && (
        <p className="mt-1.5 text-sm text-amber-200/60 italic line-clamp-2">
          &ldquo;{event.summary}&rdquo;
        </p>
      )}
    </div>
  )
}
