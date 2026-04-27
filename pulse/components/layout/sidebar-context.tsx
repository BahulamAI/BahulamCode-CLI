'use client'

import { createContext, useContext, useEffect, useState } from 'react'

interface SidebarContextType {
  collapsed: boolean
  toggle: () => void
  mobileOpen: boolean
  setMobileOpen: (v: boolean) => void
}

const SidebarContext = createContext<SidebarContextType>({
  collapsed: false,
  toggle: () => {},
  mobileOpen: false,
  setMobileOpen: () => {},
})

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        setCollapsed(localStorage.getItem('cc-sidebar-collapsed') === 'true')
      } catch {}
    }, 0)

    return () => window.clearTimeout(id)
  }, [])

  function toggle() {
    setCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem('cc-sidebar-collapsed', String(next)) } catch {}
      return next
    })
  }

  return (
    <SidebarContext.Provider value={{ collapsed, toggle, mobileOpen, setMobileOpen }}>
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  return useContext(SidebarContext)
}
