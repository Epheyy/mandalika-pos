import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from './cn'

type Size = 'sm' | 'md' | 'lg' | 'xl'

const MAX: Record<Size, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  /** Action row pinned to the bottom (e.g. Cancel / Save buttons). */
  footer?: ReactNode
  size?: Size
  /** Pad the body (default true). Set false for full-bleed list bodies. */
  padded?: boolean
  children: ReactNode
}

/** Centered overlay dialog. Click the backdrop or the × to close. */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  footer,
  size = 'md',
  padded = true,
  children,
}: ModalProps) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          'bg-white rounded-3xl shadow-2xl w-full max-h-[90vh] flex flex-col',
          MAX[size],
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || subtitle) && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
            <div className="min-w-0">
              {title && <h2 className="text-xl font-black text-gray-900 truncate">{title}</h2>}
              {subtitle && <p className="text-sm text-gray-400 truncate">{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 rounded-xl flex-shrink-0"
              aria-label="Tutup"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        )}
        <div className={cn('overflow-y-auto flex-1', padded && 'p-6')}>{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">{footer}</div>
        )}
      </div>
    </div>
  )
}
