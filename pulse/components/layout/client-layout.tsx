'use client'

import { useSidebar } from '@/components/layout/sidebar-context'

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const { collapsed } = useSidebar()
  return (
    <main
      className={[
        'flex-1 min-h-screen overflow-x-hidden bg-background pb-16 md:pb-0',
        'transition-[margin] duration-300',
        collapsed ? 'md:ml-14' : 'md:ml-56',
      ].join(' ')}
    >
      {children}
      <footer className="border-t border-border/50 py-3 px-6 flex items-center justify-center mb-16 md:mb-0">
        <p className="text-xs text-muted-foreground">
          Made by{' '}
          <a
            href="https://github.com/Arindam200"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
          >
            Arindam
          </a>
        </p>
      </footer>
    </main>
  )
}
