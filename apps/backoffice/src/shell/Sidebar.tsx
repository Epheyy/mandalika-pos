import { X } from 'lucide-react'
import { BRAND } from '../lib/brand'
import { Link } from '../lib/router/Link'
import { hashFor, type NavId, type RouteGroup } from '../lib/router/routes'
import { cn } from '../ui/cn'
import { LegendPopover } from './LegendPopover'
import type { NavBadge } from './navBadgeModel'

interface SidebarProps {
  groups: readonly RouteGroup[]
  activeId: NavId | null
  badgeOf: (id: NavId) => NavBadge | null
  /** The slide-in drawer below the lg breakpoint. */
  open: boolean
  onClose: () => void
}

function CountBadge({ badge }: { badge: NavBadge }) {
  return (
    <span
      aria-label={badge.label}
      className={cn(
        'ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold',
        badge.tone === 'danger' ? 'bg-danger-solid text-on-brand' : 'bg-warn-bg text-warn-strong',
      )}
    >
      {badge.count}
    </span>
  )
}

export function Sidebar({ groups, activeId, badgeOf, open, onClose }: SidebarProps) {
  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Tutup menu"
          tabIndex={-1}
          className="fixed inset-0 z-20 bg-ink-900/40 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={cn(
          // Below lg it is a drawer over content, so opaque (owner rule 1); docked it is non-scrolling chrome, so glass-static.
          'max-lg:surface-solid lg:surface-glass fixed inset-y-0 left-0 z-30 flex w-64 flex-col transition-transform duration-300 lg:static',
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div className="flex h-16 flex-shrink-0 items-center justify-between border-b border-paper-2 px-5">
          <div className="flex items-center gap-3">
            <img src={BRAND.logoUrl} alt="" className="h-10 w-12 object-contain" />
            <div>
              <p className="text-sm font-black text-ink-900">{BRAND.name}</p>
              <p className="text-xs text-ink-500">Back Office</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Sembunyikan menu"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-paper-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong lg:hidden"
          >
            <X className="h-4 w-4 text-ink-500" aria-hidden="true" />
          </button>
        </div>

        <nav aria-label="Menu utama" className="flex-1 overflow-y-auto px-3 pb-2">
          {groups.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-500">Tidak ada menu yang dapat diakses.</p>
          ) : (
            groups.map(({ section, routes }) => (
              <div key={section.id}>
                {/* An h2, never a button: sections are not collapsible and the tests need every item visible. */}
                <h2 className="px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                  {section.label}
                </h2>
                <ul className="space-y-0.5">
                  {routes.map((route) => {
                    const Icon = route.icon
                    const active = route.id === activeId
                    const badge = badgeOf(route.id)
                    return (
                      <li key={route.id}>
                        <Link
                          to={hashFor(route)}
                          navId={route.id}
                          aria-current={active ? 'page' : undefined}
                          onNavigated={onClose}
                          className={cn(
                            'flex h-10 items-center gap-3 rounded-[10px] px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong',
                            active
                              ? 'bg-paper-1 font-semibold text-ink-900 shadow-[inset_3px_0_0_var(--color-brand)]'
                              : 'font-medium text-ink-700 hover:bg-paper-1 hover:text-ink-900',
                          )}
                        >
                          <Icon className={cn('h-[18px] w-[18px] flex-shrink-0', active ? 'text-ink-900' : 'text-ink-500')} aria-hidden="true" />
                          <span>{route.label}</span>
                          {badge && <CountBadge badge={badge} />}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </nav>
        <LegendPopover />
      </aside>
    </>
  )
}
