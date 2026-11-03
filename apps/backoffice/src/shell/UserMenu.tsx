import { useId, useRef, useState } from 'react'
import { ChevronDown, LogOut } from 'lucide-react'
import type { User } from '@mandalika/api'
import { labelOf } from '../lib/labels/types'
import { ROLE } from '../lib/labels/role'
import { useDismiss } from './useDismiss'

interface UserMenuProps {
  user: User
  /** Asks the leave guard first; signs out only when it allows. */
  onLogout: () => void | Promise<void>
}

/** Who is signed in, and "Keluar" (D-72: moved here from the sidebar footer). */
export function UserMenu({ user, onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panelId = useId()
  useDismiss(open, () => setOpen(false), root)

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 items-center gap-2 rounded-xl px-2 text-left hover:bg-paper-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
      >
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-paper-1">
          {user.photoURL ? (
            <img src={user.photoURL} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-xs font-black text-ink-700">{user.displayName.charAt(0)}</span>
          )}
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block max-w-40 truncate text-sm font-bold text-ink-900">{user.displayName}</span>
          <span className="block text-xs text-ink-500">{labelOf(ROLE, user.role).label}</span>
        </span>
        <ChevronDown className="h-4 w-4 text-ink-500" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-full z-40 mt-1 w-56 rounded-xl border border-paper-2 bg-white p-1.5 shadow-xl"
        >
          <p className="px-3 py-2 text-xs text-ink-500">
            Masuk sebagai <b className="text-ink-900">{user.displayName}</b> · {labelOf(ROLE, user.role).label}
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              void onLogout()
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-bold text-ink-700 hover:bg-danger-bg hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" /> Keluar
          </button>
        </div>
      )}
    </div>
  )
}
