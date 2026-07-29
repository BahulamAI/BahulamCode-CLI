import { TopBar } from '@/components/layout/top-bar'
import { OverviewClient } from './overview-client'

export default function OverviewPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <TopBar
        title="b0 Pulse"
        subtitle="Real-time analytics for your b0 agent sessions"
      />
      <OverviewClient />
    </div>
  )
}
