import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import { normalizeHash } from './hash'
import { navigate } from './navigate'

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** "#/inventori", "/inventori" or "inventori?x=1": all mean the same place. */
  to: string
  /** Rendered as data-nav-id: the browser tests click sidebar items by it. */
  navId?: string
  replace?: boolean
  /** Runs after the move happened (not when a leave guard refused it). */
  onNavigated?: () => void
}

/**
 * A real anchor, so open-in-new-tab and copy-link work. A plain click is taken over: preventDefault comes
 * first, so the browser never changes the hash before the leave guard has been asked.
 */
export function Link({ to, navId, replace, onNavigated, onClick, children, ...rest }: LinkProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    void navigate(to, { replace }).then((moved) => {
      if (moved) onNavigated?.()
    })
  }
  return (
    <a {...rest} href={normalizeHash(to)} data-nav-id={navId} onClick={handleClick}>
      {children}
    </a>
  )
}
