/**
 * Slide-out left menu drawer — replaces the old top-nav link cluster.
 * Two columns: Operasional (order/history/recap/cash-flow/sync) and Pengaturan
 * (print / product-display), with a user card header and a status footer. The
 * online/offline indicator now lives in the app header (beside the shift chip),
 * not here. Icons are inline SVG (components/ui/icons) to avoid an icon dependency. Brand
 * gold comes free: index.css remaps the indigo palette to gold.
 */
import { memo } from 'react'
import type { ReactElement } from 'react'
import type { components } from '@mandalika/api'
import { hasFeature } from '../brand'
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
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all text-left ${active ? 'bg-orange-50 text-orange-600' : 'text-gray-700 hover:bg-gray-100'}`}>
      <div className={`relative p-1.5 rounded-lg flex-shrink-0 ${active ? 'bg-orange-100' : 'bg-gray-100'}`}>
        <Icon className={`w-4 h-4 ${active ? 'text-orange-600' : 'text-gray-500'}`} />
        {badge && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />}
      </div>
      <span className="leading-tight flex-1">{label}</span>
      {badge && <span className="text-[10px] font-bold bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full flex-shrink-0">Baru</span>}
      {active && !badge && <div className="ml-auto w-2 h-2 rounded-full bg-orange-500 flex-shrink-0" />}
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
      <button type="button" aria-label="Tutup" tabIndex={-1} className="flex-1 bg-black/40 animate-[backdropfade_0.2s_ease-out]" onClick={onClose} />

      {/* Panel (right, slides in from the right under the hamburger) */}
      <div className="relative w-full max-w-md bg-white shadow-2xl flex flex-col safe-top safe-bottom animate-[slideinright_0.2s_cubic-bezier(0.16,1,0.3,1)]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-black text-gray-900">Mandalika POS</p>
            <button type="button" onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg" aria-label="Tutup">
              <CloseIcon className="w-4 h-4 text-gray-400" />
            </button>
          </div>
          <div className="flex items-center gap-3 bg-indigo-50 rounded-xl px-3 py-2.5">
            <div className="w-9 h-9 rounded-full bg-indigo-200 flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-black text-indigo-700">{initial}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-black text-indigo-900 truncate">{user.displayName}</p>
              <p className="text-xs text-indigo-500 capitalize">
                {user.role}{' · '}
                {shiftActive
                  ? <span className="text-green-600 font-bold">Shift Aktif</span>
                  : <span className="text-gray-400">Tidak ada shift</span>}
              </p>
            </div>
            <button type="button" onClick={() => { onClose(); onBackOffice() }}
              className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex-shrink-0">
              Back Office <IconExternal size={14} className="inline-block align-[-0.125em]" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden divide-x divide-gray-100">
          {/* Operasional */}
          <div className="w-1/2 flex flex-col overflow-y-auto">
            <p className="px-4 pt-4 pb-2 text-xs font-bold text-gray-400 uppercase tracking-wider">Operasional</p>
            <nav className="px-2 pb-2 space-y-0.5">
              {opItems.map(renderItem)}
            </nav>
          </div>

          {/* Pengaturan */}
          <div className="w-1/2 flex flex-col overflow-y-auto">
            <p className="px-4 pt-4 pb-2 text-xs font-bold text-gray-400 uppercase tracking-wider">Pengaturan</p>
            <nav className="px-2 pb-2 space-y-0.5">
              {settingItems.map(renderItem)}
            </nav>
            <div className="mt-auto px-2 pb-2 border-t border-gray-100 pt-2">
              {/* No sign-out button and no outlet switcher: the terminal is fixed (A04). The only way
                  out is the guarded "Lepas terminal" in Pengaturan. */}
              <button type="button" onClick={() => { onClose(); onTerminal() }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-all text-left">
                <div className="p-1.5 rounded-lg bg-gray-100 flex-shrink-0">
                  <SignOutIcon className="w-4 h-4 text-gray-500" />
                </div>
                Terminal
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex-shrink-0 bg-gray-50 space-y-1">
          <p className="text-xs text-gray-400">Powered by <span className="font-bold text-gray-600">Mandalika</span></p>
          {lastSyncedLabel && (
            <p className="text-[11px] text-gray-400">Data terakhir diperbarui: {lastSyncedLabel}</p>
          )}
        </div>
      </div>
    </div>
  )
})
