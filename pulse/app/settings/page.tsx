'use client'

import useSWR from 'swr'
import { TopBar } from '@/components/layout/top-bar'
import type { SkillInfo, PluginInfo } from '@/lib/claude-reader'

const fetcher = (url: string) =>
  fetch(url).then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json() })

function formatBytes(b: number) {
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(2) + ' GB'
  if (b >= 1_048_576) return (b / 1_048_576).toFixed(1) + ' MB'
  if (b >= 1_024) return (b / 1_024).toFixed(1) + ' KB'
  return b + ' B'
}

function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span className="text-muted-foreground">null</span>
  if (typeof value === 'boolean')
    return <span className="text-amber-700 dark:text-[#fbbf24]">{String(value)}</span>
  if (typeof value === 'number')
    return <span className="text-emerald-700 dark:text-[#6ee7b7]">{value}</span>
  if (typeof value === 'string')
    return <span className="text-orange-400 dark:text-[#f9a875]">&quot;{value}&quot;</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">[]</span>
    return (
      <span>
        <span className="text-muted-foreground">[</span>
        <div className="pl-4">
          {value.map((v, i) => (
            <div key={i}>
              <JsonValue value={v} depth={depth + 1} />
              {i < value.length - 1 && <span className="text-muted-foreground/60">,</span>}
            </div>
          ))}
        </div>
        <span className="text-muted-foreground">]</span>
      </span>
    )
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return <span className="text-muted-foreground">{'{}'}</span>
    return (
      <span>
        <span className="text-muted-foreground">{'{'}</span>
        <div className="pl-4">
          {entries.map(([k, v], i) => (
            <div key={k}>
              <span className="text-muted-foreground">&quot;</span>
              <span className="text-blue-700 dark:text-[#93c5fd]">{k}</span>
              <span className="text-muted-foreground">&quot;</span>
              <span className="text-muted-foreground/60">: </span>
              <JsonValue value={v} depth={depth + 1} />
              {i < entries.length - 1 && <span className="text-muted-foreground/60">,</span>}
            </div>
          ))}
        </div>
        <span className="text-muted-foreground">{'}'}</span>
      </span>
    )
  }
  return <span className="text-foreground">{String(value)}</span>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded bg-card p-4">
      <h2 className="text-[13px] font-bold text-muted-foreground uppercase tracking-widest mb-4">{title}</h2>
      {children}
    </div>
  )
}

export default function SettingsPage() {
  const { data, error, isLoading } = useSWR<{
    settings: Record<string, unknown>
    storageBytes: number
    skills: SkillInfo[]
    plugins: PluginInfo[]
  }>('/api/settings', fetcher, { refreshInterval: 30_000 })

  return (
    <div className="flex flex-col min-h-screen">
      <TopBar title="Bahulam Pulse · settings" subtitle="~/.bahulam/settings.json" />
      <div className="p-4 md:p-6 space-y-6">
        {error && <p className="text-[#f87171] text-sm font-mono">Error: {String(error)}</p>}
        {isLoading && (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 bg-muted rounded animate-pulse" />
            ))}
          </div>
        )}
        {data && (
          <>
            <Section title="Storage">
              <div className="flex items-center gap-3">
                <span className="text-primary text-2xl font-mono font-bold">
                  {formatBytes(data.storageBytes)}
                </span>
                <span className="text-muted-foreground text-sm font-mono">used by ~/.bahulam/</span>
              </div>
            </Section>

            <Section title="Settings">
              {Object.keys(data.settings).length === 0 ? (
                <p className="text-muted-foreground/60 text-sm font-mono">No settings found in ~/.bahulam/settings.json</p>
              ) : (
                <div className="font-mono text-sm leading-relaxed overflow-x-auto">
                  <JsonValue value={data.settings} />
                </div>
              )}
            </Section>

            {data.settings.env && (
              <Section title="Environment Variables">
                <div className="font-mono text-sm leading-relaxed overflow-x-auto">
                  <JsonValue value={data.settings.env} />
                </div>
              </Section>
            )}

            {data.settings.mcpServers && (
              <Section title="MCP Servers">
                <div className="space-y-3">
                  {Object.entries(data.settings.mcpServers as Record<string, unknown>).map(([name, cfg]) => (
                    <div key={name} className="border border-border rounded p-3">
                      <p className="text-primary font-mono text-sm font-bold mb-2">{name}</p>
                      <div className="font-mono text-xs text-muted-foreground overflow-x-auto">
                        <JsonValue value={cfg} />
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title={`Skills (${data.skills.length})`}>
              {data.skills.length === 0 ? (
                <p className="text-muted-foreground/60 text-sm font-mono">No skills found in ~/.bahulam/skills/</p>
              ) : (
                <div className="grid gap-2">
                  {data.skills.map(skill => (
                    <div key={skill.name} className="border border-border rounded p-3 flex items-start gap-3">
                      <span className="shrink-0 w-2 h-2 mt-1.5 rounded-full bg-primary" />
                      <div className="min-w-0">
                        <p className="text-primary font-mono text-sm font-bold">{skill.name}</p>
                        {skill.description && (
                          <p className="text-foreground text-xs mt-0.5">{skill.description}</p>
                        )}
                        {skill.triggers && (
                          <p className="text-muted-foreground text-xs mt-1 leading-relaxed line-clamp-2">{skill.triggers}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {data.plugins.length > 0 && (
              <Section title={`Plugins (${data.plugins.length})`}>
                <div className="grid gap-2">
                  {data.plugins.map((plugin, i) => (
                    <div key={i} className="border border-border rounded p-3 flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-primary font-mono text-sm font-bold">{plugin.id}</p>
                        <p className="text-muted-foreground text-xs mt-0.5">scope: {plugin.scope}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="text-emerald-700 dark:text-[#6ee7b7] font-mono text-xs">v{plugin.version}</span>
                        <p className="text-muted-foreground text-xs mt-0.5">
                          {new Date(plugin.installedAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
