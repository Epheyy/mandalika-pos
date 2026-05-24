import { useEffect, useRef, useState, type ReactNode } from 'react'
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

/** Centered overlay dialog. Closing via the backdrop or the × asks to confirm
 *  when the body has unsaved edits (any input changed since it opened). Explicit
 *  footer buttons (Batal/Simpan) are the caller's responsibility. */
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
  const dirty = useRef(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (open) {
      dirty.current = false
      setConfirming(false)
    }
  }, [open])

  if (!open) return null

  const requestClose = () => {
    if (dirty.current) setConfirming(true)
    else onClose()
  }
  const discard = () => {
    dirty.current = false
    setConfirming(false)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={requestClose}
    >
      <div
        className={cn(
          'bg-white rounded-3xl shadow-2xl w-full max-h-[90vh] flex flex-col',
          MAX[size],
        )}
        onClick={(e) => e.stopPropagation()}
        onChangeCapture={() => {
          dirty.current = true
        }}
      >
        {(title || subtitle) && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
            <div className="min-w-0">
              {title && <h2 className="text-xl font-black text-gray-900 truncate">{title}</h2>}
              {subtitle && <p className="text-sm text-gray-400 truncate">{subtitle}</p>}
            </div>
            <button
              onClick={requestClose}
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

      {confirming && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
          onClick={(e) => {
            e.stopPropagation()
            setConfirming(false)
          }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-xs text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-black text-gray-900 mb-1">Buang perubahan?</h3>
            <p className="text-sm text-gray-400 mb-5">
              Perubahan yang belum disimpan akan hilang.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirming(false)}
                className="flex-1 py-2.5 border-2 border-gray-200 text-gray-600 font-bold rounded-xl"
              >
                Lanjut Edit
              </button>
              <button
                onClick={discard}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl"
              >
                Buang
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
