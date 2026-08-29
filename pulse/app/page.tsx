import { TopBar } from '@/components/layout/top-bar'
import { OverviewClient } from './overview-client'

export default function OverviewPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <TopBar
        title="Bahulam Pulse"
        subtitle="Real-time analytics for your Bahulam Code agent sessions"
      />
      <OverviewClient />
    </div>
  )
}
