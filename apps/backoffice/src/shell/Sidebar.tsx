import { X } from 'lucide-react'
import type { User } from '@mandalika/api'
import { labelOf } from '../lib/labels/types'
import { ROLE } from '../lib/labels/role'
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
  user: User
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

export function Sidebar({ groups, activeId, badgeOf, user, open, onClose }: SidebarProps) {
  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Tutup menu"
          tabIndex={-1}
          className="fixed inset-0 z-[26] bg-ink-900/40 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={cn(
          // Below lg it is a drawer over content, so opaque (owner rule 1); docked it is non-scrolling chrome, so glass-static (tint, never a blur).
          // A floating card in both forms (SH-01): docked it fills the frame's height, as a drawer it keeps the same margin.
          'max-lg:surface-solid lg:surface-glass-static fixed inset-y-2 left-2 z-30 flex w-64 flex-col rounded-3xl transition-transform duration-300 sm:inset-y-3 sm:left-3 lg:static lg:inset-auto lg:flex-shrink-0',
          open ? 'translate-x-0' : '-translate-x-[calc(100%+1rem)] lg:translate-x-0',
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
              <div key={section.id} className="border-t border-ink-900/[0.08] first:border-t-0">
                {/* An h2, never a button: sections are not collapsible and the tests need every item visible. */}
                <h2 className="px-3 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
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
                              ? 'bg-brand-strong/[0.13] font-semibold text-ink-900'
                              : 'font-medium text-ink-700 hover:bg-paper-1 hover:text-ink-900',
                          )}
                        >
                          <Icon className={cn('h-[18px] w-[18px] flex-shrink-0', active ? 'text-brand-strong' : 'text-ink-500')} aria-hidden="true" />
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
        <p className="flex-shrink-0 border-t border-paper-2 px-5 py-3 text-center text-xs text-ink-700">
          Masuk sebagai {labelOf(ROLE, user.role).label}
        </p>
      </aside>
    </>
  )
}
