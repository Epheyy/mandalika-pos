/**
 * Slide-out left menu drawer — replaces the old top-nav link cluster.
 * Two columns: Operasional (order/history/recap/sync) and Pengaturan
 * (settings + view prefs), with a user card header and a status footer.
 * Icons are inline SVG to avoid pulling in an icon dependency. Brand gold
 * comes free: index.css remaps the indigo palette to gold.
 */
import { memo } from 'react'
import type { components } from '@mandalika/api'

type User = components['schemas']['User']

interface MenuDrawerProps {
  open: boolean
  onClose: () => void
  user: User
  shiftActive: boolean
  isOnline: boolean
  pendingSync: boolean
  isSyncing: boolean
  lastSyncedLabel?: string | null
  onTakeOrder: () => void
  onHistory: () => void
  onRecap: () => void
  onSync: () => void
  onSettings: () => void
  onBackOffice: () => void
  onLogout: () => void
}

type IconProps = { className?: string }

const BagIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" /></svg>
)
const HistoryIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" /></svg>
)
const RecapIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 12h6M9 16h6" /></svg>
)
const SyncIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
)
const SettingsIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
)
const LogoutIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
)
const CloseIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
)

export const MenuDrawer = memo(function MenuDrawer({
  open,
  onClose,
  user,
  shiftActive,
  isOnline,
  pendingSync,
  isSyncing,
  lastSyncedLabel,
  onTakeOrder,
  onHistory,
  onRecap,
  onSync,
  onSettings,
  onBackOffice,
  onLogout,
}: MenuDrawerProps) {
  if (!open) return null

  const initial = (user.displayName || '?').charAt(0).toUpperCase()

  const opItems = [
    { Icon: BagIcon, label: 'Ambil Pesanan', active: true, onClick: () => { onTakeOrder() } },
    { Icon: HistoryIcon, label: 'Riwayat', onClick: () => { onClose(); onHistory() } },
    { Icon: RecapIcon, label: 'Rekapan', onClick: () => { onClose(); onRecap() } },
    { Icon: SyncIcon, label: isSyncing ? 'Menyinkronkan…' : 'Sinkronkan', badge: pendingSync, onClick: () => onSync() },
  ]

  return (
    <div className="fixed inset-0 z-[60] flex">
      {/* Panel */}
      <div className="relative w-full max-w-md bg-white shadow-2xl flex flex-col safe-top safe-bottom animate-[slidein_0.18s_ease-out]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-black text-gray-900">Mandalika POS</p>
            <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg" aria-label="Tutup">
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
            <button onClick={() => { onClose(); onBackOffice() }}
              className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex-shrink-0">
              Back Office →
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden divide-x divide-gray-100">
          {/* Operasional */}
          <div className="w-1/2 flex flex-col overflow-y-auto">
            <p className="px-4 pt-4 pb-2 text-xs font-bold text-gray-400 uppercase tracking-wider">Operasional</p>
            <nav className="px-2 pb-2 space-y-0.5">
              {opItems.map(({ Icon, label, active, badge, onClick }) => (
                <button key={label} onClick={onClick}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all text-left ${active ? 'bg-orange-50 text-orange-600' : 'text-gray-700 hover:bg-gray-100'}`}>
                  <div className={`relative p-1.5 rounded-lg flex-shrink-0 ${active ? 'bg-orange-100' : 'bg-gray-100'}`}>
                    <Icon className={`w-4 h-4 ${active ? 'text-orange-600' : 'text-gray-500'}`} />
                    {badge && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />}
                  </div>
                  <span className="leading-tight flex-1">{label}</span>
                  {badge && <span className="text-[10px] font-bold bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full flex-shrink-0">Baru</span>}
                  {active && !badge && <div className="ml-auto w-2 h-2 rounded-full bg-orange-500 flex-shrink-0" />}
                </button>
              ))}
            </nav>
          </div>

          {/* Pengaturan */}
          <div className="w-1/2 flex flex-col overflow-y-auto">
            <p className="px-4 pt-4 pb-2 text-xs font-bold text-gray-400 uppercase tracking-wider">Pengaturan</p>
            <nav className="px-2 pb-2 space-y-0.5">
              <button onClick={() => { onClose(); onSettings() }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold text-gray-700 hover:bg-gray-100 transition-all text-left">
                <div className="p-1.5 rounded-lg bg-gray-100 flex-shrink-0">
                  <SettingsIcon className="w-4 h-4 text-gray-500" />
                </div>
                <span className="leading-tight">Pengaturan</span>
              </button>
            </nav>
            <div className="mt-auto px-2 pb-2 border-t border-gray-100 pt-2">
              <button onClick={() => { onClose(); onLogout() }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold text-red-600 hover:bg-red-50 transition-all text-left">
                <div className="p-1.5 rounded-lg bg-red-50 flex-shrink-0">
                  <LogoutIcon className="w-4 h-4 text-red-500" />
                </div>
                Keluar dari Aplikasi
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex-shrink-0 bg-gray-50 space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-400">Powered by <span className="font-bold text-gray-600">Mandalika</span></p>
            <div className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`} />
              <p className="text-xs text-gray-500 font-medium">{isOnline ? 'Online' : 'Offline'}</p>
            </div>
          </div>
          {lastSyncedLabel && (
            <p className="text-[11px] text-gray-400">Terakhir sinkronisasi: {lastSyncedLabel}</p>
          )}
        </div>
      </div>

      {/* Backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose} />
    </div>
  )
})
