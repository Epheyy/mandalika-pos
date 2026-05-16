import { useEffect, useState } from 'react'
import type { AppSettings } from '@mandalika/api'
import { Loader2, Plus, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'

const DEFAULT: AppSettings = {
  taxEnabled: true,
  taxRate: 11,
  roundingEnabled: false,
  roundingType: 'nearest_500',
  roundingAmount: 1000,
  roundingDirection: 'floor',
  roundingApplyToTax: false,
  paymentMethods: [
    { id: 'cash', label: 'Tunai', isEnabled: true },
    { id: 'card', label: 'Kartu', isEnabled: true },
    { id: 'qris', label: 'QRIS', isEnabled: true },
    { id: 'transfer', label: 'Transfer', isEnabled: true },
  ],
  receipt: {
    headerText: 'Mandalika Perfume',
    footerText: 'Terima kasih telah berbelanja!',
    showTax: true,
    showCashier: true,
    copies: 1,
    autoPrint: false,
    showOrderNumber: true,
    showCustomerName: true,
    showCustomerPhone: true,
    showDiscount: true,
    showSubtotal: true,
    showChange: true,
  },
  autoOpenShift: false,
}

export default function SettingsScreen() {
  const q = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], 30000)
  const [s, setS] = useState<AppSettings>(DEFAULT)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [newPay, setNewPay] = useState('')
  const [section, setSection] = useState<'tax' | 'payment' | 'receipt' | 'shift'>('tax')

  useEffect(() => {
    if (q.data && !loaded) {
      setS({ ...DEFAULT, ...q.data })
      setLoaded(true)
    }
  }, [q.data, loaded])

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      await api.updateAppSettings(s)
      setMsg('Pengaturan disimpan!')
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Gagal menyimpan.')
    } finally {
      setSaving(false)
    }
  }

  const setReceipt = (k: string, v: unknown) =>
    setS((p) => ({ ...p, receipt: { ...p.receipt, [k]: v } }))

  const sections = [
    { id: 'tax', label: 'Pajak & Pembulatan' },
    { id: 'payment', label: 'Metode Pembayaran' },
    { id: 'receipt', label: 'Struk' },
    { id: 'shift', label: 'Shift' },
  ] as const

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Pengaturan</h2>
          <p className="text-sm text-gray-400">Konfigurasi sistem POS</p>
        </div>
        <button onClick={save} disabled={saving} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-xl shadow-lg shadow-indigo-100">
          {saving ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan Semua'}
        </button>
      </div>
      {msg && <p className={`text-sm ${msg.includes('disimpan') ? 'text-green-600' : 'text-red-600'}`}>{msg}</p>}

      <div className="flex gap-2 flex-wrap">
        {sections.map((sec) => (
          <button key={sec.id} onClick={() => setSection(sec.id)} className={`px-4 py-2 rounded-xl text-sm font-bold ${section === sec.id ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-indigo-300'}`}>
            {sec.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-6 max-w-2xl space-y-5">
        {section === 'tax' && (
          <>
            <h3 className="font-black text-gray-900">Pajak & Pembulatan</h3>
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-900">Aktifkan PPN</p>
                <p className="text-xs text-gray-400">Pajak dihitung di kasir</p>
              </div>
              <button onClick={() => setS((p) => ({ ...p, taxEnabled: !p.taxEnabled }))}>
                {s.taxEnabled ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7 text-gray-400" />}
              </button>
            </div>
            {s.taxEnabled && (
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tarif Pajak (%)</label>
                <input type="number" value={s.taxRate} onChange={(e) => setS((p) => ({ ...p, taxRate: parseFloat(e.target.value) || 0 }))} className="w-32 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            )}
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-900">Pembulatan Harga</p>
                <p className="text-xs text-gray-400">Membulatkan total transaksi</p>
              </div>
              <button onClick={() => setS((p) => ({ ...p, roundingEnabled: !p.roundingEnabled }))}>
                {s.roundingEnabled ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7 text-gray-400" />}
              </button>
            </div>
            {s.roundingEnabled && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Pembulatan ke</label>
                  <select value={s.roundingAmount ?? 1000} onChange={(e) => setS((p) => ({ ...p, roundingAmount: parseInt(e.target.value) }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    {[1, 10, 100, 500, 1000].map((v) => <option key={v} value={v}>{v.toLocaleString('id-ID')}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tipe Pembulatan</label>
                  <select value={s.roundingDirection ?? 'floor'} onChange={(e) => setS((p) => ({ ...p, roundingDirection: e.target.value as AppSettings['roundingDirection'] }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="floor">Ke bawah</option>
                    <option value="ceil">Ke atas</option>
                    <option value="nearest">Terdekat</option>
                  </select>
                </div>
              </div>
            )}
          </>
        )}

        {section === 'payment' && (
          <>
            <h3 className="font-black text-gray-900">Metode Pembayaran</h3>
            <div className="space-y-2">
              {s.paymentMethods.map((pm) => (
                <div key={pm.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                  <span className="font-bold text-gray-900 text-sm">{pm.label}</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setS((p) => ({ ...p, paymentMethods: p.paymentMethods.map((x) => x.id === pm.id ? { ...x, isEnabled: !x.isEnabled } : x) }))}>
                      {pm.isEnabled ? <ToggleRight className="w-6 h-6 text-indigo-600" /> : <ToggleLeft className="w-6 h-6 text-gray-400" />}
                    </button>
                    {!['cash', 'card', 'qris', 'transfer'].includes(pm.id) && (
                      <button onClick={() => setS((p) => ({ ...p, paymentMethods: p.paymentMethods.filter((x) => x.id !== pm.id) }))} className="p-1.5 hover:bg-red-50 hover:text-red-500 text-gray-300 rounded-lg">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input type="text" value={newPay} onChange={(e) => setNewPay(e.target.value)} placeholder="Nama metode baru..." className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <button onClick={() => {
                if (!newPay.trim()) return
                const pid = newPay.toLowerCase().replace(/\s+/g, '_')
                if (s.paymentMethods.some((p) => p.id === pid)) return
                setS((p) => ({ ...p, paymentMethods: [...p.paymentMethods, { id: pid, label: newPay.trim(), isEnabled: true }] }))
                setNewPay('')
              }} className="p-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700">
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </>
        )}

        {section === 'receipt' && (
          <>
            <h3 className="font-black text-gray-900">Pengaturan Struk</h3>
            <div>
              <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-1">Jumlah Salinan</label>
              <input type="number" min={1} max={5} value={s.receipt.copies ?? 1} onChange={(e) => setReceipt('copies', parseInt(e.target.value) || 1)} className="w-32 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div className="flex items-center justify-between py-2 border-b border-gray-100">
              <p className="font-bold text-gray-900 text-sm">Cetak struk otomatis</p>
              <button onClick={() => setReceipt('autoPrint', !s.receipt.autoPrint)}>
                {s.receipt.autoPrint ? <ToggleRight className="w-6 h-6 text-indigo-600" /> : <ToggleLeft className="w-6 h-6 text-gray-400" />}
              </button>
            </div>
            {([['headerText', 'Teks Header'], ['footerText', 'Teks Footer']] as const).map(([k, label]) => (
              <div key={k}>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{label}</label>
                <input type="text" value={s.receipt[k]} onChange={(e) => setReceipt(k, e.target.value)} className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            ))}
            <div className="border border-gray-100 rounded-xl overflow-hidden">
              {([
                ['showOrderNumber', 'Nomor pesanan'],
                ['showCashier', 'Dicetak oleh'],
                ['showCustomerName', 'Nama Pelanggan'],
                ['showCustomerPhone', 'Nomor Telepon'],
                ['showTax', 'Tampilkan Pajak'],
                ['showDiscount', 'Tampilkan Diskon'],
                ['showSubtotal', 'Tampilkan Subtotal'],
                ['showChange', 'Tampilkan Kembalian'],
              ] as const).map(([k, label]) => (
                <div key={k} className="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0">
                  <p className="font-bold text-gray-900 text-sm">{label}</p>
                  <button onClick={() => setReceipt(k, !s.receipt[k])}>
                    {s.receipt[k] ? <ToggleRight className="w-6 h-6 text-indigo-600" /> : <ToggleLeft className="w-6 h-6 text-gray-400" />}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {section === 'shift' && (
          <>
            <h3 className="font-black text-gray-900">Pengaturan Shift</h3>
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-bold text-gray-900">Buka Shift Otomatis</p>
                <p className="text-xs text-gray-400">Shift dibuka otomatis saat kasir login</p>
              </div>
              <button onClick={() => setS((p) => ({ ...p, autoOpenShift: !p.autoOpenShift }))}>
                {s.autoOpenShift ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7 text-gray-400" />}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
