/**
 * Focused settings modals — one per drawer menu item, instead of a single
 * massive right-side panel. The `section` prop picks which one renders:
 *   - 'display'  → "Pengaturan Tampilan Produk" (font size + product grid)
 *   - 'printer'  → "Pengaturan Cetakan" (Bluetooth printer + receipt/tax info)
 *   - 'cashflow' → "Uang Masuk / Keluar" (cash in/out entry)
 *   - 'terminal' → outlet/account of this tablet + guarded "Lepas terminal"
 * Each renders as a centered modal (portrait-friendly). Receipt/tax are
 * Backoffice-owned and shown read-only. Cash flow queues via
 * engine.enqueue('cash_flow', ...).
 */

import { memo, use, useRef, useState } from 'react'
import type { components } from '@mandalika/api'
import { SyncContext } from '../cashier/SyncProvider'
import { formatRupiah } from '../cashier/pricing'
import { usePrinter } from '../printer'
import { createSubmitGate, notSavedMessage } from '../lib/durableSubmit'
import { offlineLockMessage } from '../lib/offlineCap'
import { TerminalSection } from './TerminalSection'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'

type AppSettings = components['schemas']['AppSettings']
type Shift = components['schemas']['Shift']

type FontSize = 'sm' | 'md' | 'lg'
type GridCols = 2 | 3 | 4 | 6

export type SettingsSection = 'display' | 'printer' | 'cashflow' | 'terminal'

const TITLES: Record<SettingsSection, string> = {
  display: 'Pengaturan Tampilan Produk',
  printer: 'Pengaturan Cetakan',
  cashflow: 'Kas Masuk / Keluar',
  terminal: 'Terminal',
}

interface SettingsScreenProps {
  section: SettingsSection
  settings: AppSettings
  currentShift: Shift | null
  fontSize: FontSize
  gridCols: GridCols
  showPrice: boolean
  showStock: boolean
  showVariants: boolean
  /** D-4: hide the system's expected amounts at Tutup Shift until every Terhitung is entered. */
  blindCount: boolean
  onFontSizeChange: (size: FontSize) => void
  onGridColsChange: (cols: GridCols) => void
  onShowPriceChange: (v: boolean) => void
  onShowStockChange: (v: boolean) => void
  onShowVariantsChange: (v: boolean) => void
  onBlindCountChange: (v: boolean) => void
  onClose: () => void
}

/** Compact labelled on/off switch. */
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="press w-full min-h-11 flex items-center justify-between py-1.5"
    >
      <span className="text-sm text-ink-900">{label}</span>
      <span className={`relative w-10 h-6 rounded-full flex-shrink-0 ${checked ? 'bg-brand-strong' : 'bg-paper-2'}`}>
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </span>
    </button>
  )
}

export const SettingsScreen = memo(function SettingsScreen({
  section,
  settings,
  currentShift,
  fontSize,
  gridCols,
  showPrice,
  showStock,
  showVariants,
  blindCount,
  onFontSizeChange,
  onGridColsChange,
  onShowPriceChange,
  onShowStockChange,
  onShowVariantsChange,
  onBlindCountChange,
  onClose,
}: SettingsScreenProps) {
  const engine = use(SyncContext)
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

  const cashFlowGate = useRef(createSubmitGate())

  const handleSaveCashFlow = async () => {
    if (!engine || cashFlowGate.current.isBusy()) return
    const amt = parseFloat(cashFlowAmount)
    if (!amt || amt <= 0) {
      setCashFlowMsg('Masukkan jumlah yang valid')
      return
    }
    if (!cashFlowDesc.trim()) {
      setCashFlowMsg('Deskripsi wajib diisi')
      return
    }
    // A05: cash in/out locks past 12 h offline; the engine never refuses, so the UI gates here.
    const lockedMsg = offlineLockMessage(engine.offlineState())
    if (lockedMsg) {
      setCashFlowMsg(lockedMsg)
      return
    }
    setIsSavingCashFlow(true)
    setCashFlowMsg(null)
    const outcome = await cashFlowGate.current.run(() => engine.enqueue('cash_flow', {
      shiftId: currentShift?.id || null, // '' = open not yet synced
      type: cashFlowType,
      amount: amt,
      description: cashFlowDesc.trim(),
    }))
    if (outcome.status === 'busy') return
    setIsSavingCashFlow(false)
    if (outcome.status === 'failed') {
      // Not stored: keep the typed amount/description so the cashier can retry.
      setCashFlowMsg(notSavedMessage('Kas masuk/keluar'))
      return
    }
    setCashFlowAmount('')
    setCashFlowDesc('')
    setCashFlowMsg('Berhasil disimpan (akan terkirim)')
  }

  return (
    <Sheet open variant="center" maxWidth="max-w-sm" panelClassName="max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between py-1 pl-5 pr-2 border-b border-paper-2 flex-shrink-0">
          <h2 className="text-lg font-bold text-ink-900">{TITLES[section]}</h2>
          <button type="button"
            onClick={onClose}
            className="press inline-flex h-11 w-11 items-center justify-center rounded-control text-xl leading-none text-ink-700 active:bg-paper-1"
            aria-label="Tutup"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* ── Pengaturan Tampilan Produk ── */}
          {section === 'display' && (
            <div className="space-y-4">
              <div>
                <p className="text-xs text-ink-700 font-semibold mb-1.5">Ukuran Font</p>
                <div className="flex gap-2">
                  {(['sm', 'md', 'lg'] as FontSize[]).map((s) => (
                    <button type="button"
                      key={s}
                      onClick={() => onFontSizeChange(s)}
                      className={`press flex-1 min-h-11 py-1.5 rounded-control text-xs font-semibold border ${
                        fontSize === s
                          ? 'bg-brand-strong text-on-brand border-brand-strong'
                          : 'surface-card text-ink-700'
                      }`}
                    >
                      {s.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-xs text-ink-700 font-semibold mb-1.5">Kolom Grid Produk</p>
                <div className="flex gap-2">
                  {([2, 3, 4, 6] as GridCols[]).map((c) => (
                    <button type="button"
                      key={c}
                      onClick={() => onGridColsChange(c)}
                      className={`press flex-1 min-h-11 py-1.5 rounded-control text-xs font-semibold border ${
                        gridCols === c
                          ? 'bg-brand-strong text-on-brand border-brand-strong'
                          : 'surface-card text-ink-700'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-xs text-ink-700 font-semibold mb-1">Detail di Kartu Produk</p>
                <div className="divide-y divide-paper-2">
                  <Toggle label="Tampilkan Harga" checked={showPrice} onChange={onShowPriceChange} />
                  <Toggle label="Tampilkan Stok" checked={showStock} onChange={onShowStockChange} />
                  <Toggle label="Tampilkan Varian" checked={showVariants} onChange={onShowVariantsChange} />
                </div>
              </div>

              <div>
                <p className="text-xs text-ink-700 font-semibold mb-1">Tutup Shift</p>
                <div className="divide-y divide-paper-2">
                  <Toggle label="Tutup Shift: sembunyikan angka sistem" checked={blindCount} onChange={onBlindCountChange} />
                </div>
                <p className="mt-1 text-[11px] text-ink-700">Angka Tercatat dan Selisih baru tampil setelah semua Terhitung diisi.</p>
              </div>
            </div>
          )}

          {/* ── Pengaturan Cetakan ── */}
          {section === 'printer' && (
            <div className="space-y-4">
              {!printer.supported ? (
                <div className="surface-group rounded-control p-3 text-xs text-ink-700">
                  Cetak Bluetooth hanya di aplikasi native. Mode browser memakai
                  pratinjau struk di layar.
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="surface-group rounded-control p-3 text-xs text-ink-700 flex justify-between items-center">
                    <span>Printer</span>
                    <span className="font-semibold text-ink-900">
                      {printer.isPaired ? (printer.pairedName ?? 'Tersambung') : 'Belum diatur'}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => void handleShowBonded()}
                      disabled={printerBusy}
                      className="flex-1 text-xs"
                    >
                      {printer.isPaired ? 'Ganti Printer' : 'Pilih Printer Terpasang'}
                    </Button>
                    {printer.isPaired && (
                      <Button
                        variant="secondary"
                        onClick={() => void handleTestPrint()}
                        disabled={printerBusy}
                        className="flex-1 text-xs"
                      >
                        Tes Cetak
                      </Button>
                    )}
                  </div>

                  {bonded !== null && (
                    <div className="space-y-1">
                      {bonded.map((d) => (
                        <button type="button"
                          key={d.deviceId}
                          onClick={() => {
                            printer.pairTo(d.deviceId, d.name)
                            setBonded(null)
                            setPrinterMsg(`Printer dipilih: ${d.name}`)
                          }}
                          className="press surface-card w-full min-h-11 text-left px-3 py-2 rounded-control text-xs active:bg-paper-1"
                        >
                          <span className="font-semibold text-ink-900">{d.name}</span>
                          <span className="block text-[10px] text-ink-500">{d.deviceId}</span>
                        </button>
                      ))}
                      <button type="button"
                        onClick={() => { setBonded(null); void handlePair() }}
                        disabled={printerBusy}
                        className="press w-full min-h-11 py-1.5 text-[11px] text-brand-strong font-semibold disabled:opacity-50"
                      >
                        Tidak ada di daftar? Pindai (scan)
                      </button>
                    </div>
                  )}
                  {printer.isPaired && (
                    <button type="button"
                      onClick={printer.unpair}
                      className="press w-full min-h-11 py-1.5 text-xs text-danger font-semibold"
                    >
                      Hapus Printer
                    </button>
                  )}
                  {printerMsg && (
                    <p
                      className={`text-xs ${
                        printerMsg.includes('Gagal') || printerMsg.includes('Tidak')
                          ? 'text-danger'
                          : 'text-ok'
                      }`}
                    >
                      {printerMsg}
                    </p>
                  )}
                </div>
              )}

              {/* Receipt settings (read-only, Backoffice-owned) */}
              <div>
                <p className="text-[11px] font-bold text-ink-500 uppercase tracking-widest mb-2">Struk (Backoffice)</p>
                <div className="surface-group rounded-control p-3 text-xs text-ink-700 space-y-1">
                  <div className="flex justify-between">
                    <span>Tampilkan Pajak</span>
                    <span>{settings.receipt.showTax ? '✓' : '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tampilkan Kasir</span>
                    <span>{settings.receipt.showCashier ? '✓' : '—'}</span>
                  </div>
                  {settings.receipt.headerText && (
                    <div><span className="text-ink-500">Header: </span>{settings.receipt.headerText}</div>
                  )}
                  {settings.receipt.footerText && (
                    <div><span className="text-ink-500">Footer: </span>{settings.receipt.footerText}</div>
                  )}
                  <p className="text-[10px] text-ink-500 mt-1">Diatur di Backoffice</p>
                </div>
              </div>

              {/* Tax (read-only) */}
              <div>
                <p className="text-[11px] font-bold text-ink-500 uppercase tracking-widest mb-2">Pajak</p>
                <div className="surface-group rounded-control p-3 text-xs text-ink-700">
                  {settings.taxEnabled ? `PPN ${settings.taxRate}% aktif` : 'Pajak tidak aktif'}
                  {settings.roundingEnabled && (
                    <span className="ml-2 text-ink-500">· Pembulatan {settings.roundingType}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Terminal (Lepas terminal) ── */}
          {section === 'terminal' && <TerminalSection />}

          {/* ── Uang Masuk / Keluar ── */}
          {section === 'cashflow' && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <button type="button"
                  onClick={() => setCashFlowType('in')}
                  className={`press flex-1 min-h-11 py-1.5 rounded-control text-xs font-semibold border ${
                    cashFlowType === 'in'
                      ? 'bg-ok text-white border-ok'
                      : 'surface-card text-ink-700'
                  }`}
                >
                  Kas Masuk
                </button>
                <button type="button"
                  onClick={() => setCashFlowType('out')}
                  className={`press flex-1 min-h-11 py-1.5 rounded-control text-xs font-semibold border ${
                    cashFlowType === 'out'
                      ? 'bg-danger-solid text-white border-danger-solid'
                      : 'surface-card text-ink-700'
                  }`}
                >
                  Kas Keluar
                </button>
              </div>
              <input
                type="number"
                inputMode="numeric"
                value={cashFlowAmount}
                onChange={(e) => { setCashFlowAmount(e.target.value); setCashFlowMsg(null) }}
                placeholder="Jumlah (Rp)"
                className="w-full min-h-11 border border-paper-2 bg-white rounded-control px-3 py-2 text-sm text-ink-900 focus:outline-none focus:border-ink-700"
              />
              {cashFlowAmount && !isNaN(parseFloat(cashFlowAmount)) && (
                <p className="tnum text-[10px] text-ink-700">= {formatRupiah(parseFloat(cashFlowAmount))}</p>
              )}
              <input
                value={cashFlowDesc}
                onChange={(e) => { setCashFlowDesc(e.target.value); setCashFlowMsg(null) }}
                placeholder="Keterangan *"
                className="w-full min-h-11 border border-paper-2 bg-white rounded-control px-3 py-2 text-sm text-ink-900 focus:outline-none focus:border-ink-700"
              />
              {cashFlowMsg && (
                <p className={`text-xs ${cashFlowMsg.startsWith('Berhasil') ? 'text-ok' : 'text-danger'}`}>
                  {cashFlowMsg}
                </p>
              )}
              <Button fullWidth onClick={() => void handleSaveCashFlow()} disabled={isSavingCashFlow || !engine}>
                Simpan
              </Button>
            </div>
          )}
        </div>
    </Sheet>
  )
})
