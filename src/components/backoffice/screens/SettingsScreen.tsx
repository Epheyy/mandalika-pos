import { useState, useEffect } from 'react'
import type { AppUser, AppSettings } from '../../../types'
import { db } from '../../../firebase'
import { doc, onSnapshot, setDoc } from 'firebase/firestore'
import { Loader2, Plus, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'

interface Props { appUser?: AppUser }

const DEFAULT_SETTINGS: AppSettings = {
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

export default function SettingsScreen({ appUser: _appUser }: Props) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [isSaving, setIsSaving] = useState(false)
  const [newPayment, setNewPayment] = useState('')
  const [activeSection, setActiveSection] = useState<'tax' | 'payment' | 'receipt' | 'shift'>('tax')

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'settings', 'app'), snap => {
      if (snap.exists()) setSettings({ ...DEFAULT_SETTINGS, ...snap.data() as AppSettings })
    })
    return () => unsub()
  }, [])

  const save = async () => {
    setIsSaving(true)
    try {
      await setDoc(doc(db, 'settings', 'app'), settings)
      alert('Pengaturan disimpan!')
    } catch { alert('Gagal menyimpan.') }
    finally { setIsSaving(false) }
  }

  const togglePayment = (id: string) => {
    setSettings(s => ({ ...s, paymentMethods: s.paymentMethods.map(p => p.id === id ? { ...p, isEnabled: !p.isEnabled } : p) }))
  }

  const removePayment = (id: string) => {
    if (['cash', 'card', 'qris', 'transfer'].includes(id)) { alert('Metode pembayaran default tidak bisa dihapus.'); return }
    setSettings(s => ({ ...s, paymentMethods: s.paymentMethods.filter(p => p.id !== id) }))
  }

  const addPayment = () => {
    if (!newPayment.trim()) return
    const id = newPayment.toLowerCase().replace(/\s+/g, '_')
    if (settings.paymentMethods.find(p => p.id === id)) { alert('Sudah ada.'); return }
    setSettings(s => ({ ...s, paymentMethods: [...s.paymentMethods, { id, label: newPayment.trim(), isEnabled: true }] }))
    setNewPayment('')
  }

  const setReceipt = (key: string, value: any) => {
    setSettings(s => ({ ...s, receipt: { ...s.receipt, [key]: value } }))
  }

  const sections = [
    { id: 'tax', label: 'Pajak & Pembulatan' },
    { id: 'payment', label: 'Metode Pembayaran' },
    { id: 'receipt', label: 'Struk' },
    { id: 'shift', label: 'Shift' },
  ] as const

  const roundingAmounts = [1, 10, 100, 500, 1000]

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Pengaturan</h2>
          <p className="text-sm text-gray-400">Konfigurasi sistem POS</p>
        </div>
        <button onClick={save} disabled={isSaving}
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-100">
          {isSaving ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan Semua'}
        </button>
      </div>

      {/* Section tabs */}
      <div className="flex gap-2 flex-wrap">
        {sections.map(s => (
          <button key={s.id} onClick={() => setActiveSection(s.id)}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${activeSection === s.id ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-indigo-300'}`}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-6 max-w-2xl space-y-5">

        {/* TAX & ROUNDING */}
        {activeSection === 'tax' && (
          <>
            <h3 className="font-black text-gray-900">Pajak & Pembulatan</h3>

            {/* Tax toggle */}
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-900">Aktifkan PPN</p>
                <p className="text-xs text-gray-400">Pajak akan ditampilkan & dihitung di kasir</p>
              </div>
              <button onClick={() => setSettings(s => ({ ...s, taxEnabled: !s.taxEnabled }))} className="text-gray-400 hover:text-indigo-600">
                {settings.taxEnabled ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7" />}
              </button>
            </div>
            {settings.taxEnabled && (
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tarif Pajak (%)</label>
                <input type="number" value={settings.taxRate}
                  onChange={e => setSettings(s => ({ ...s, taxRate: parseFloat(e.target.value) || 0 }))}
                  className="w-32 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            )}

            {/* Rounding section */}
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-900">Pembulatan Harga</p>
                <p className="text-xs text-gray-400">Membulatkan total transaksi</p>
              </div>
              <button onClick={() => setSettings(s => ({ ...s, roundingEnabled: !s.roundingEnabled }))} className="text-gray-400 hover:text-indigo-600">
                {settings.roundingEnabled ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7" />}
              </button>
            </div>

            {settings.roundingEnabled && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  {/* Rounding amount dropdown */}
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Pembulatan ke</label>
                    <select value={settings.roundingAmount ?? 1000}
                      onChange={e => setSettings(s => ({ ...s, roundingAmount: parseInt(e.target.value) }))}
                      className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                      {roundingAmounts.map(v => (
                        <option key={v} value={v}>{v.toLocaleString('id-ID')}</option>
                      ))}
                    </select>
                  </div>

                  {/* Rounding direction */}
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tipe Pembulatan</label>
                    <select value={settings.roundingDirection ?? 'floor'}
                      onChange={e => setSettings(s => ({ ...s, roundingDirection: e.target.value as any }))}
                      className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                      <option value="floor">Pembulatan ke bawah</option>
                      <option value="ceil">Pembulatan ke atas</option>
                      <option value="nearest">Pembulatan terdekat</option>
                    </select>
                  </div>
                </div>

                {/* Apply to tax */}
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                  <input type="checkbox" id="roundTax"
                    checked={settings.roundingApplyToTax ?? false}
                    onChange={e => setSettings(s => ({ ...s, roundingApplyToTax: e.target.checked }))}
                    className="w-4 h-4 accent-indigo-600" />
                  <div>
                    <label htmlFor="roundTax" className="text-sm font-bold text-gray-900 cursor-pointer">Terapkan Pembulatan pada Service Charge dan Pajak</label>
                    <p className="text-xs text-gray-400">Service charge dan pajak akan dibulatkan ke 1 terdekat</p>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* PAYMENT METHODS */}
        {activeSection === 'payment' && (
          <>
            <h3 className="font-black text-gray-900">Metode Pembayaran</h3>
            <div className="space-y-2">
              {settings.paymentMethods.map(pm => (
                <div key={pm.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                  <span className="font-bold text-gray-900 text-sm">{pm.label}</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => togglePayment(pm.id)} className="text-gray-400 hover:text-indigo-600">
                      {pm.isEnabled ? <ToggleRight className="w-6 h-6 text-indigo-600" /> : <ToggleLeft className="w-6 h-6" />}
                    </button>
                    <button onClick={() => removePayment(pm.id)} className="p-1.5 hover:bg-red-50 hover:text-red-500 text-gray-300 rounded-lg transition-all">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input type="text" value={newPayment} onChange={e => setNewPayment(e.target.value)}
                placeholder="Nama metode baru..."
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                onKeyDown={e => e.key === 'Enter' && addPayment()} />
              <button onClick={addPayment} className="p-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700">
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </>
        )}

        {/* RECEIPT */}
        {activeSection === 'receipt' && (
          <>
            <h3 className="font-black text-gray-900">Pengaturan Struk</h3>

            {/* Jumlah salinan */}
            <div>
              <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Jumlah Salinan Struk</label>
              <p className="text-xs text-gray-400 mb-2">Atur jumlah salinan dalam satu cetakan</p>
              <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-1">Jumlah salinan</label>
              <input type="number" min={1} max={5} value={settings.receipt.copies ?? 1}
                onChange={e => setReceipt('copies', parseInt(e.target.value) || 1)}
                className="w-32 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>

            {/* Cetak otomatis */}
            <div className="flex items-center justify-between py-2 border-b border-gray-100">
              <p className="font-bold text-gray-900 text-sm">Cetak struk otomatis</p>
              <button onClick={() => setReceipt('autoPrint', !settings.receipt.autoPrint)} className="text-gray-400 hover:text-indigo-600">
                {settings.receipt.autoPrint ? <ToggleRight className="w-6 h-6 text-indigo-600" /> : <ToggleLeft className="w-6 h-6" />}
              </button>
            </div>

            {/* Header / Footer */}
            {[
              { key: 'headerText', label: 'Teks Header', placeholder: 'Nama toko / tagline' },
              { key: 'footerText', label: 'Teks Footer', placeholder: 'Pesan terima kasih' },
            ].map(({ key, label, placeholder }) => (
              <div key={key}>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{label}</label>
                <input type="text" value={settings.receipt[key as 'headerText' | 'footerText']}
                  onChange={e => setReceipt(key, e.target.value)}
                  placeholder={placeholder}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            ))}

            {/* Isi struk toggles */}
            <div>
              <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3">Isi Struk</p>
              <div className="space-y-0 border border-gray-100 rounded-xl overflow-hidden">
                {[
                  { key: 'showOrderNumber', label: 'Nomor pesanan' },
                  { key: 'showCashier', label: 'Dicetak oleh' },
                  { key: 'showCustomerName', label: 'Nama Pelanggan' },
                  { key: 'showCustomerPhone', label: 'Nomor Telepon Pelanggan' },
                  { key: 'showTax', label: 'Tampilkan Pajak' },
                  { key: 'showDiscount', label: 'Tampilkan Diskon' },
                  { key: 'showSubtotal', label: 'Tampilkan Subtotal' },
                  { key: 'showChange', label: 'Tampilkan Kembalian' },
                ].map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0">
                    <p className="font-bold text-gray-900 text-sm">{label}</p>
                    <button onClick={() => setReceipt(key, !(settings.receipt as any)[key])} className="text-gray-400 hover:text-indigo-600">
                      {(settings.receipt as any)[key] ? <ToggleRight className="w-6 h-6 text-indigo-600" /> : <ToggleLeft className="w-6 h-6" />}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* SHIFT */}
        {activeSection === 'shift' && (
          <>
            <h3 className="font-black text-gray-900">Pengaturan Shift</h3>
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-bold text-gray-900">Buka Shift Otomatis</p>
                <p className="text-xs text-gray-400">Shift dibuka otomatis saat kasir login tanpa perlu input kas awal</p>
              </div>
              <button onClick={() => setSettings(s => ({ ...s, autoOpenShift: !s.autoOpenShift }))} className="text-gray-400 hover:text-indigo-600">
                {settings.autoOpenShift ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7" />}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
