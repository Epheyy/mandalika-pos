/**
 * Slide-out left menu drawer — replaces the old top-nav link cluster.
 * Two columns: Operasional (order/history/recap/cash-flow/sync) and Pengaturan
 * (print / product-display), with a user card header and a status footer. The
 * online/offline indicator now lives in the app header (beside the shift chip),
 * not here. Icons are inline SVG (components/ui/icons) to avoid an icon dependency. Kaca:
 * opaque surface-solid panel, paper/ink/brand tokens, 44px rows.
 */
import { memo } from 'react'
import type { ReactElement } from 'react'
import type { components } from '@mandalika/api'
import { hasFeature } from '../brand'
import { StatusBadge } from '../components/ui/StatusBadge'
import {
  IconCash as CashIcon,
  IconClose as CloseIcon,
  IconExternal,
  IconDisplay as DisplayIcon,
  IconHistory as HistoryIcon,
  IconInbox as InboxIcon,
  IconSignOut as SignOutIcon,
  IconPrinter as PrinterIcon,
  IconRecap as RecapIcon,
  IconSync as SyncIcon,
  IconTransferHistory as TransferHistoryIcon,
  type IconProps,
} from '../components/ui/icons'

type User = components['schemas']['User']

interface MenuDrawerProps {
  open: boolean
  onClose: () => void
  user: User
  shiftActive: boolean
  pendingSync: boolean
  isSyncing: boolean
  lastSyncedLabel?: string | null
  /** D-6 Pesanan tersimpan: how many carts are parked on this tablet, and the door to them. */
  heldCount: number
  onHeldOrders: () => void
  onHistory: () => void
  onLocalReceipts: () => void
  onRecap: () => void
  onCashFlow: () => void
  onSync: () => void
  onPrintSettings: () => void
  onProductDisplay: () => void
  onBackOffice: () => void
  onTerminal: () => void
  onReceiveTransfer: () => void
  onOpenTransferHistory: () => void
  /** Permintaan Barang: shown only when the signed-in user may request stock. */
  canRequestStock: boolean
  onRequisitions: () => void
  inboundCount: number
}

type Item = {
  Icon: (p: IconProps) => ReactElement
  label: string
  active?: boolean
  badge?: boolean
  onClick: () => void
}

const renderItem = ({ Icon, label, active, badge, onClick }: Item) => (
    <button type="button" key={label} onClick={onClick}
      className={`press w-full flex items-center gap-3 min-h-11 px-3 py-2 rounded-control text-sm font-semibold text-left active:bg-paper-1 ${active ? 'bg-paper-1 text-brand-strong' : 'text-ink-900'}`}>
      <div className={`relative p-1.5 rounded-control flex-shrink-0 ${active ? 'bg-paper-2' : 'bg-paper-1'}`}>
        <Icon className={`w-4 h-4 ${active ? 'text-brand-strong' : 'text-ink-700'}`} />
        {badge && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-danger" />}
      </div>
      <span className="leading-tight flex-1">{label}</span>
      {badge && <StatusBadge tone="brand" label="Baru" className="flex-shrink-0" />}
      {active && !badge && <div className="ml-auto w-2 h-2 rounded-full bg-brand flex-shrink-0" />}
    </button>
  )

export const MenuDrawer = memo(function MenuDrawer({
  open,
  onClose,
  user,
  shiftActive,
  pendingSync,
  isSyncing,
  lastSyncedLabel,
  heldCount,
  onHeldOrders,
  onHistory,
  onLocalReceipts,
  onRecap,
  onCashFlow,
  onSync,
  onPrintSettings,
  onProductDisplay,
  onBackOffice,
  onTerminal,
  onReceiveTransfer,
  onOpenTransferHistory,
  canRequestStock,
  onRequisitions,
  inboundCount,
}: MenuDrawerProps) {
  if (!open) return null

  const initial = (user.displayName || '?').charAt(0).toUpperCase()

  const opItems: Item[] = [
    { Icon: InboxIcon, label: heldCount > 0 ? `Pesanan tersimpan (${heldCount})` : 'Pesanan tersimpan', onClick: () => { onClose(); onHeldOrders() } },
    { Icon: HistoryIcon, label: 'Riwayat', onClick: () => { onClose(); onHistory() } },
    { Icon: HistoryIcon, label: 'Struk di Tablet Ini', onClick: () => { onClose(); onLocalReceipts() } },
    { Icon: RecapIcon, label: 'Rekap Shift', onClick: () => { onClose(); onRecap() } },
    { Icon: CashIcon, label: 'Kas Masuk/Keluar', onClick: () => { onClose(); onCashFlow() } },
    { Icon: InboxIcon, label: 'Terima Transfer', badge: inboundCount > 0, onClick: () => { onClose(); onReceiveTransfer() } },
    { Icon: TransferHistoryIcon, label: 'Riwayat Transfer', onClick: () => { onClose(); onOpenTransferHistory() } },
    ...(canRequestStock && hasFeature('requisitions') ? [{ Icon: InboxIcon, label: 'Permintaan Barang', onClick: () => { onClose(); onRequisitions() } }] : []),
    { Icon: SyncIcon, label: isSyncing ? 'Memperbarui data…' : 'Perbarui data', badge: pendingSync, onClick: () => onSync() },
  ]

  const settingItems: Item[] = [
    { Icon: PrinterIcon, label: 'Pengaturan Cetakan', onClick: () => { onClose(); onPrintSettings() } },
    { Icon: DisplayIcon, label: 'Pengaturan Tampilan Produk', onClick: () => { onClose(); onProductDisplay() } },
  ]

  return (
    <div className="fixed inset-0 z-[60] flex">
      {/* Backdrop (left) */}
      <button type="button" aria-label="Tutup" tabIndex={-1} className="flex-1 bg-ink-900/40 animate-[backdropfade_var(--d-enter)_var(--ease-std)]" onClick={onClose} />

      {/* Panel (right, slides in from the right under the hamburger) */}
      <div className="relative w-full max-w-md surface-solid rounded-l-panel flex flex-col safe-top safe-bottom animate-[slideinright_var(--d-enter)_var(--ease-std)]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-paper-2 flex-shrink-0">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-black text-ink-900">Mandalika POS</p>
            <button type="button" onClick={onClose} className="press -mr-2 inline-flex h-11 w-11 items-center justify-center rounded-control active:bg-paper-1" aria-label="Tutup">
              <CloseIcon className="w-4 h-4 text-ink-700" />
            </button>
          </div>
          <div className="flex items-center gap-3 surface-group rounded-control px-3 py-2.5">
            <div className="w-9 h-9 rounded-full bg-paper-2 flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-black text-brand-strong">{initial}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-black text-ink-900 truncate">{user.displayName}</p>
              <p className="text-xs text-ink-700 capitalize">
                {user.role}{' · '}
                {shiftActive
                  ? <span className="text-ok font-bold">Shift Aktif</span>
                  : <span className="text-ink-500">Tidak ada shift</span>}
              </p>
            </div>
            <button type="button" onClick={() => { onClose(); onBackOffice() }}
              className="press inline-flex min-h-11 flex-shrink-0 items-center gap-1 rounded-control px-2 text-xs font-bold text-brand-strong active:bg-paper-1">
              Back Office <IconExternal size={14} className="inline-block align-[-0.125em]" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 divide-x divide-paper-2">
          {/* Operasional */}
          <div className="w-1/2 flex flex-col overflow-y-auto">
            <p className="px-4 pt-4 pb-2 text-xs font-bold text-ink-500 uppercase tracking-wider">Operasional</p>
            <nav className="px-2 pb-2 space-y-0.5">
              {opItems.map(renderItem)}
            </nav>
          </div>

          {/* Pengaturan */}
          <div className="w-1/2 flex flex-col overflow-y-auto">
            <p className="px-4 pt-4 pb-2 text-xs font-bold text-ink-500 uppercase tracking-wider">Pengaturan</p>
            <nav className="px-2 pb-2 space-y-0.5">
              {settingItems.map(renderItem)}
            </nav>
            <div className="mt-auto px-2 pb-2 border-t border-paper-2 pt-2">
              {/* No sign-out button and no outlet switcher: the terminal is fixed (A04). The only way
                  out is the guarded "Lepas terminal" in Pengaturan. */}
              <button type="button" onClick={() => { onClose(); onTerminal() }}
                className="press w-full flex items-center gap-3 min-h-11 px-3 py-2 rounded-control text-sm font-semibold text-ink-900 text-left active:bg-paper-1">
                <div className="p-1.5 rounded-control bg-paper-1 flex-shrink-0">
                  <SignOutIcon className="w-4 h-4 text-ink-700" />
                </div>
                Terminal
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-paper-2 flex-shrink-0 space-y-1">
          <p className="text-xs text-ink-500">Powered by <span className="font-bold text-ink-700">Mandalika</span></p>
          {lastSyncedLabel && (
            <p className="text-[11px] text-ink-500">Data terakhir diperbarui: {lastSyncedLabel}</p>
          )}
        </div>
      </div>
    </div>
  )
})
