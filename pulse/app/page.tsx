import { TopBar } from '@/components/layout/top-bar'
import { OverviewClient } from './overview-client'

export default function OverviewPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <TopBar
        title="Kepler Pulse"
        subtitle="Real-time analytics for your Kepler AI agent sessions"
      />
      <OverviewClient />
    </div>
  )
}
