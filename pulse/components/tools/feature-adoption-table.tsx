interface Props {
  adoption: Record<string, { sessions: number; pct: number }>
  totalSessions: number
}

const FEATURE_LABELS: Record<string, { label: string; icon: string }> = {
  task_agents:      { label: 'Task Agents',        icon: '🤖' },
  mcp:              { label: 'MCP Servers',         icon: '🔌' },
  web_search:       { label: 'Web Search',          icon: '🔍' },
  web_fetch:        { label: 'Web Fetch',           icon: '🌐' },
  plan_mode:        { label: 'Plan Mode',           icon: '📋' },
  git_commits:      { label: 'Git Commits',         icon: '📦' },
  extended_thinking: { label: 'Extended Thinking',  icon: '🧠' },
}

export function FeatureAdoptionTable({ adoption, totalSessions }: Props) {
  const rows = Object.entries(adoption)
    .map(([key, data]) => ({ key, ...data, ...FEATURE_LABELS[key] }))
    .filter(r => r.label)
    .sort((a, b) => b.sessions - a.sessions)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border">
            <th className="py-2 text-left text-[12px] font-bold text-muted-foreground uppercase tracking-wider">Feature</th>
            <th className="py-2 text-right text-[12px] font-bold text-muted-foreground uppercase tracking-wider">Sessions</th>
            <th className="py-2 text-right text-[12px] font-bold text-muted-foreground uppercase tracking-wider">% of Total</th>
            <th className="py-2 pl-4 text-left text-[12px] font-bold text-muted-foreground uppercase tracking-wider w-32">Adoption</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const pct = (r.pct * 100).toFixed(1)
            const width = Math.round(r.pct * 100)
            return (
              <tr key={r.key} className="border-b border-border/30 hover:bg-muted/30 transition-colors">
                <td className="py-2">
                  <span className="mr-1.5">{r.icon}</span>
                  <span className="text-foreground/80">{r.label}</span>
                </td>
                <td className="py-2 text-right text-foreground font-bold">{r.sessions}</td>
                <td className="py-2 text-right text-[#d97706]">{pct}%</td>
                <td className="py-2 pl-4">
                  <div className="h-2 bg-muted rounded-full overflow-hidden w-24">
                    <div className="h-full rounded-full bg-[#d97706]/60" style={{ width: `${width}%` }} />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="text-[12px] text-muted-foreground/40 mt-2">{totalSessions} total sessions analyzed</p>
    </div>
  )
}
