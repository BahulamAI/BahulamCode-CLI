import { TopBar } from '@/components/layout/top-bar'
import { OverviewClient } from './overview-client'

export default function OverviewPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <TopBar
        title="Orca Pulse"
        subtitle="Real-time analytics for your Orca AI agent sessions"
      />
      <OverviewClient />
    </div>
  )
}
