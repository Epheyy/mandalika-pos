/**
 * Slide-out menu drawer. Two columns: Operasional (held orders / history / recap / cash flow / transfers /
 * sync) and Pengaturan (print / product display / terminal / Back Office), under a one-row identity header
 * (gold initial, "Name · Role", outlet · shift) and a one-line footer, compact so it fits the A9's 601 px.
 * Rows are filled 44px tiles with a chevron (↗ when external) and optional count tags. The online/offline
 * indicator lives in the app header, not here. Icons are inline SVG (components/ui/icons). Kaca: opaque
 * surface-solid panel, paper/ink/brand tokens.
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
  /** W7-06: the outlet shown under the user's name (W7 mock: "outlet · shift"). Optional: the shift number is not available here. */
  outletName?: string | null
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
  /** W7-05: a count tag (e.g. "2", "1 dikirim") shown before the chevron. */
  count?: { text: string; tone: 'warn' | 'danger' }
  /** Pending-attention marker: red dot on the icon + "Baru" tag (Perbarui data). */
  badge?: boolean
  /** W7-04: ↗ instead of › for rows that leave the app. */
  external?: boolean
  onClick: () => void
}

/** W7-04: a filled 44px tile with a trailing chevron (↗ when external); the active row gets a gold outline. */
const renderItem = ({ Icon, label, active, count, badge, external, onClick }: Item) => (
    <button type="button" key={label} onClick={onClick}
      className={`press w-full flex items-center gap-2.5 min-h-11 px-3 rounded-control text-sm font-semibold text-left ${active ? 'bg-white border-[1.5px] border-brand-strong text-brand-strong' : 'bg-paper-1 text-ink-900 active:bg-paper-2'}`}>
      <span className="relative flex-shrink-0">
        <Icon className={`w-4 h-4 ${active ? 'text-brand-strong' : 'text-ink-700'}`} />
        {badge && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-danger" />}
      </span>
      <span className="leading-tight flex-1">{label}</span>
      {count && <StatusBadge tone={count.tone} label={count.text} className="flex-shrink-0" />}
      {badge && <StatusBadge tone="brand" label="Baru" className="flex-shrink-0" />}
      {external
        ? <IconExternal size={14} className="flex-shrink-0 text-ink-500" />
        : <span aria-hidden="true" className="flex-shrink-0 text-ink-500">›</span>}
    </button>
  )

export const MenuDrawer = memo(function MenuDrawer({
  open,
  onClose,
  user,
  shiftActive,
  pendingSync,
  isSyncing,
  outletName,
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
    { Icon: InboxIcon, label: 'Pesanan tersimpan', count: heldCount > 0 ? { text: String(heldCount), tone: 'warn' } : undefined, onClick: () => { onClose(); onHeldOrders() } },
    { Icon: HistoryIcon, label: 'Riwayat', onClick: () => { onClose(); onHistory() } },
    { Icon: HistoryIcon, label: 'Struk di Tablet Ini', onClick: () => { onClose(); onLocalReceipts() } },
    { Icon: RecapIcon, label: 'Rekap Shift', onClick: () => { onClose(); onRecap() } },
    { Icon: CashIcon, label: 'Kas Masuk/Keluar', onClick: () => { onClose(); onCashFlow() } },
    { Icon: InboxIcon, label: 'Terima Transfer', count: inboundCount > 0 ? { text: `${inboundCount} dikirim`, tone: 'danger' } : undefined, onClick: () => { onClose(); onReceiveTransfer() } },
    { Icon: TransferHistoryIcon, label: 'Riwayat Transfer', onClick: () => { onClose(); onOpenTransferHistory() } },
    ...(canRequestStock && hasFeature('requisitions') ? [{ Icon: InboxIcon, label: 'Permintaan Barang', onClick: () => { onClose(); onRequisitions() } }] : []),
    { Icon: SyncIcon, label: isSyncing ? 'Memperbarui data…' : 'Perbarui data', badge: pendingSync, onClick: () => onSync() },
  ]

  const settingItems: Item[] = [
    { Icon: PrinterIcon, label: 'Pengaturan Cetakan', onClick: () => { onClose(); onPrintSettings() } },
    { Icon: DisplayIcon, label: 'Pengaturan Tampilan Produk', onClick: () => { onClose(); onProductDisplay() } },
    { Icon: SignOutIcon, label: 'Terminal', onClick: () => { onClose(); onTerminal() } },
    // W7-06: the Back Office door is a menu row (↗), not a header link.
    { Icon: IconExternal, label: 'Buka Back Office', external: true, onClick: () => { onClose(); onBackOffice() } },
  ]

  return (
    <div className="fixed inset-0 z-[60] flex">
      {/* Backdrop (left) */}
      <button type="button" aria-label="Tutup" tabIndex={-1} className="flex-1 bg-ink-900/40 animate-[backdropfade_var(--d-enter)_var(--ease-std)]" onClick={onClose} />

      {/* Panel (right, slides in from the right under the hamburger). Compact so both columns fit the A9's 601 px (W7-03). */}
      <div className="relative w-full max-w-lg surface-solid rounded-l-panel flex flex-col safe-top safe-bottom animate-[slideinright_var(--d-enter)_var(--ease-std)]">
        {/* Header: identity (W7-06) */}
        <div className="px-4 py-3 border-b border-paper-2 flex-shrink-0 flex items-center gap-3">
          <div className="w-10 h-10 rounded-control bg-brand-strong text-on-brand flex items-center justify-center flex-shrink-0">
            <span className="text-base font-black">{initial}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-black text-ink-900 truncate">
              {user.displayName}{user.role ? <span className="capitalize">{' · '}{user.role}</span> : null}
            </p>
            <p className="text-xs text-ink-700 truncate">
              {outletName ? `${outletName} · ` : ''}
              {shiftActive
                ? <span className="text-ok font-bold">Shift Aktif</span>
                : <span className="text-ink-500">Tidak ada shift</span>}
            </p>
          </div>
          <button type="button" onClick={onClose} className="press inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-control active:bg-paper-1" aria-label="Tutup">
            <CloseIcon className="w-4 h-4 text-ink-700" />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 divide-x divide-paper-2">
          {/* Operasional */}
          <div className="w-1/2 flex flex-col overflow-y-auto">
            <p className="px-4 pt-3 pb-1.5 text-xs font-bold text-ink-500 uppercase tracking-wider">Operasional</p>
            <nav className="px-2 pb-2 space-y-1">
              {opItems.map(renderItem)}
            </nav>
          </div>

          {/* Pengaturan (no sign-out button and no outlet switcher: the terminal is fixed (A04). The only way
              out is the guarded "Lepas terminal" in Pengaturan.) */}
          <div className="w-1/2 flex flex-col overflow-y-auto">
            <p className="px-4 pt-3 pb-1.5 text-xs font-bold text-ink-500 uppercase tracking-wider">Pengaturan</p>
            <nav className="px-2 pb-2 space-y-1">
              {settingItems.map(renderItem)}
            </nav>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-paper-2 flex-shrink-0">
          <p className="text-[11px] text-ink-500">
            Powered by <span className="font-bold text-ink-700">Mandalika</span>
            {lastSyncedLabel ? ` · Data terakhir diperbarui: ${lastSyncedLabel}` : ''}
          </p>
        </div>
      </div>
    </div>
  )
})
