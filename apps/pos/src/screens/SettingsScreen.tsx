/**
 * Settings screen: receipt settings (read-only from snapshot), UI prefs (localStorage),
 * sync-now button, and cash flow entry via engine.enqueue('cash_flow', ...).
 * Receipt settings are Backoffice-owned — displayed read-only here.
 */

import { memo, useContext, useState } from 'react'
import type { components } from '@mandalika/api'
import { SyncContext } from '../cashier/SyncProvider'
import { formatRupiah } from '../cashier/pricing'
import { usePrinter } from '../printer'

type AppSettings = components['schemas']['AppSettings']
type Shift = components['schemas']['Shift']

type FontSize = 'sm' | 'md' | 'lg'
type GridCols = 2 | 3 | 4 | 6

interface SettingsScreenProps {
  settings: AppSettings
  currentShift: Shift | null
  fontSize: FontSize
  gridCols: GridCols
  defaultView: 'products' | 'cart'
  onFontSizeChange: (size: FontSize) => void
  onGridColsChange: (cols: GridCols) => void
  onDefaultViewChange: (view: 'products' | 'cart') => void
  onResync: () => Promise<void>
  isResyncing: boolean
  onClose: () => void
}

export const SettingsScreen = memo(function SettingsScreen({
  settings,
  currentShift,
  fontSize,
  gridCols,
  defaultView,
  onFontSizeChange,
  onGridColsChange,
  onDefaultViewChange,
  onResync,
  isResyncing,
  onClose,
}: SettingsScreenProps) {
  const engine = useContext(SyncContext)
  const printer = usePrinter()
  const [printerBusy, setPrinterBusy] = useState(false)
  const [printerMsg, setPrinterMsg] = useState<string | null>(null)
  const [bonded, setBonded] = useState<{ deviceId: string; name: string }[] | null>(null)

  const handleShowBonded = async () => {
    setPrinterBusy(true)
    setPrinterMsg(null)
    try {
      const list = await printer.listBonded()
      setBonded(list)
      if (list.length === 0) {
        setPrinterMsg('Tidak ada perangkat terpasang. Pasangkan printer di Pengaturan Bluetooth HP dulu, atau gunakan Pindai.')
      }
    } catch (e: unknown) {
      setPrinterMsg(e instanceof Error ? e.message : 'Gagal memuat perangkat')
    } finally {
      setPrinterBusy(false)
    }
  }

  const handlePair = async () => {
    setPrinterBusy(true)
    setPrinterMsg(null)
    try {
      const ok = await printer.pair()
      setPrinterMsg(ok ? 'Printer tersambung' : 'Tidak ada printer dipilih')
    } catch (e: unknown) {
      setPrinterMsg(e instanceof Error ? e.message : 'Gagal memasangkan printer')
    } finally {
      setPrinterBusy(false)
    }
  }

  const handleTestPrint = async () => {
    setPrinterBusy(true)
    setPrinterMsg(null)
    try {
      await printer.testPrint(settings.receipt)
      setPrinterMsg('Tes cetak terkirim')
    } catch (e: unknown) {
      setPrinterMsg(e instanceof Error ? e.message : 'Gagal mencetak')
    } finally {
      setPrinterBusy(false)
    }
  }

  const [cashFlowType, setCashFlowType] = useState<'in' | 'out'>('in')
  const [cashFlowAmount, setCashFlowAmount] = useState('')
  const [cashFlowDesc, setCashFlowDesc] = useState('')
  const [isSavingCashFlow, setIsSavingCashFlow] = useState(false)
  const [cashFlowMsg, setCashFlowMsg] = useState<string | null>(null)

  const handleSaveCashFlow = () => {
    if (!engine) return
    const amt = parseFloat(cashFlowAmount)
    if (!amt || amt <= 0) {
      setCashFlowMsg('Masukkan jumlah yang valid')
      return
    }
    if (!cashFlowDesc.trim()) {
      setCashFlowMsg('Deskripsi wajib diisi')
      return
    }
    setIsSavingCashFlow(true)
    try {
      engine.enqueue('cash_flow', {
        shiftId: currentShift?.id ?? null,
        type: cashFlowType,
        amount: amt,
        description: cashFlowDesc.trim(),
      })
      setCashFlowAmount('')
      setCashFlowDesc('')
      setCashFlowMsg('Berhasil disimpan (akan disinkronisasi)')
    } finally {
      setIsSavingCashFlow(false)
    }
  }

  const Section = ({ title }: { title: string }) => (
    <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2 mt-4">
      {title}
    </p>
  )

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex">
      <div className="ml-auto w-80 bg-white h-full flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="font-bold text-gray-900">Pengaturan</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-8">
          {/* Sync */}
          <Section title="Sinkronisasi" />
          <button
            onClick={() => void onResync()}
            disabled={isResyncing}
            className="w-full py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50 hover:bg-indigo-700 transition-colors mb-2"
          >
            {isResyncing ? 'Menyinkronisasi…' : 'Sinkronisasi Sekarang'}
          </button>

          {/* UI Preferences */}
          <Section title="Tampilan" />

          <div className="mb-3">
            <p className="text-xs text-gray-600 font-semibold mb-1.5">
              Ukuran Font
            </p>
            <div className="flex gap-2">
              {(['sm', 'md', 'lg'] as FontSize[]).map((s) => (
                <button
                  key={s}
                  onClick={() => onFontSizeChange(s)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    fontSize === s
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-3">
            <p className="text-xs text-gray-600 font-semibold mb-1.5">
              Kolom Grid Produk
            </p>
            <div className="flex gap-2">
              {([2, 3, 4, 6] as GridCols[]).map((c) => (
                <button
                  key={c}
                  onClick={() => onGridColsChange(c)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    gridCols === c
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-3">
            <p className="text-xs text-gray-600 font-semibold mb-1.5">
              Tampilan Default
            </p>
            <div className="flex gap-2">
              {(['products', 'cart'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => onDefaultViewChange(v)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    defaultView === v
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {v === 'products' ? 'Produk' : 'Keranjang'}
                </button>
              ))}
            </div>
          </div>

          {/* Receipt Settings (read-only) */}
          <Section title="Struk (Backoffice)" />
          <div className="bg-gray-50 rounded-xl p-3 text-xs text-gray-600 space-y-1">
            <div className="flex justify-between">
              <span>Tampilkan Pajak</span>
              <span>{settings.receipt.showTax ? '✓' : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span>Tampilkan Kasir</span>
              <span>{settings.receipt.showCashier ? '✓' : '—'}</span>
            </div>
            {settings.receipt.headerText && (
              <div>
                <span className="text-gray-400">Header: </span>
                {settings.receipt.headerText}
              </div>
            )}
            {settings.receipt.footerText && (
              <div>
                <span className="text-gray-400">Footer: </span>
                {settings.receipt.footerText}
              </div>
            )}
            <p className="text-[10px] text-gray-400 mt-1">
              Diatur di Backoffice
            </p>
          </div>

          {/* Bluetooth printer (plan §6) */}
          <Section title="Printer Bluetooth" />
          {!printer.supported ? (
            <div className="bg-gray-50 rounded-xl p-3 text-xs text-gray-500">
              Cetak Bluetooth hanya di aplikasi native. Mode browser memakai
              pratinjau struk di layar.
            </div>
          ) : (
            <div className="space-y-2">
              <div className="bg-gray-50 rounded-xl p-3 text-xs text-gray-600 flex justify-between items-center">
                <span>Printer</span>
                <span className="font-semibold text-gray-800">
                  {printer.isPaired
                    ? (printer.pairedName ?? 'Tersambung')
                    : 'Belum diatur'}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void handleShowBonded()}
                  disabled={printerBusy}
                  className="flex-1 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold disabled:opacity-50 hover:bg-indigo-700 transition-colors"
                >
                  {printer.isPaired ? 'Ganti Printer' : 'Pilih Printer Terpasang'}
                </button>
                {printer.isPaired && (
                  <button
                    onClick={() => void handleTestPrint()}
                    disabled={printerBusy}
                    className="flex-1 py-2 border border-gray-200 text-gray-700 rounded-xl text-xs font-semibold disabled:opacity-50 hover:bg-gray-50 transition-colors"
                  >
                    Tes Cetak
                  </button>
                )}
              </div>

              {bonded !== null && (
                <div className="space-y-1">
                  {bonded.map((d) => (
                    <button
                      key={d.deviceId}
                      onClick={() => {
                        printer.pairTo(d.deviceId, d.name)
                        setBonded(null)
                        setPrinterMsg(`Printer dipilih: ${d.name}`)
                      }}
                      className="w-full text-left px-3 py-2 bg-gray-50 hover:bg-indigo-50 rounded-lg text-xs"
                    >
                      <span className="font-semibold text-gray-800">{d.name}</span>
                      <span className="block text-[10px] text-gray-400">{d.deviceId}</span>
                    </button>
                  ))}
                  <button
                    onClick={() => { setBonded(null); void handlePair() }}
                    disabled={printerBusy}
                    className="w-full py-1.5 text-[11px] text-indigo-600 font-semibold disabled:opacity-50"
                  >
                    Tidak ada di daftar? Pindai (scan)
                  </button>
                </div>
              )}
              {printer.isPaired && (
                <button
                  onClick={printer.unpair}
                  className="w-full py-1.5 text-xs text-red-500 hover:text-red-600 font-semibold"
                >
                  Hapus Printer
                </button>
              )}
              {printerMsg && (
                <p
                  className={`text-xs ${
                    printerMsg.includes('Gagal') || printerMsg.includes('Tidak')
                      ? 'text-red-500'
                      : 'text-green-600'
                  }`}
                >
                  {printerMsg}
                </p>
              )}
            </div>
          )}

          {/* Tax settings (read-only) */}
          <Section title="Pajak" />
          <div className="bg-gray-50 rounded-xl p-3 text-xs text-gray-600">
            {settings.taxEnabled
              ? `PPN ${settings.taxRate}% aktif`
              : 'Pajak tidak aktif'}
            {settings.roundingEnabled && (
              <span className="ml-2 text-gray-400">
                · Pembulatan {settings.roundingType}
              </span>
            )}
          </div>

          {/* Cash flow entry */}
          <Section title="Kas Masuk / Keluar" />
          <div className="space-y-2">
            <div className="flex gap-2">
              <button
                onClick={() => setCashFlowType('in')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  cashFlowType === 'in'
                    ? 'bg-green-600 text-white border-green-600'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                Kas Masuk
              </button>
              <button
                onClick={() => setCashFlowType('out')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  cashFlowType === 'out'
                    ? 'bg-red-600 text-white border-red-600'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                Kas Keluar
              </button>
            </div>
            <input
              type="number"
              value={cashFlowAmount}
              onChange={(e) => {
                setCashFlowAmount(e.target.value)
                setCashFlowMsg(null)
              }}
              placeholder="Jumlah (Rp)"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            {cashFlowAmount && !isNaN(parseFloat(cashFlowAmount)) && (
              <p className="text-[10px] text-gray-500">
                = {formatRupiah(parseFloat(cashFlowAmount))}
              </p>
            )}
            <input
              value={cashFlowDesc}
              onChange={(e) => {
                setCashFlowDesc(e.target.value)
                setCashFlowMsg(null)
              }}
              placeholder="Keterangan *"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            {cashFlowMsg && (
              <p
                className={`text-xs ${
                  cashFlowMsg.startsWith('Berhasil')
                    ? 'text-green-600'
                    : 'text-red-500'
                }`}
              >
                {cashFlowMsg}
              </p>
            )}
            <button
              onClick={handleSaveCashFlow}
              disabled={isSavingCashFlow || !engine}
              className="w-full py-2 bg-gray-800 text-white rounded-xl text-sm font-semibold disabled:opacity-50 hover:bg-gray-900 transition-colors"
            >
              Simpan
            </button>
          </div>
        </div>
      </div>
    </div>
  )
})
