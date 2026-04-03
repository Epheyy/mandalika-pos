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
    setSettings(s => ({
      ...s,
      paymentMethods: s.paymentMethods.map(p => p.id === id ? { ...p, isEnabled: !p.isEnabled } : p)
    }))
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

        {/* TAX */}
        {activeSection === 'tax' && (
          <>
            <h3 className="font-black text-gray-900">Pajak & Pembulatan</h3>
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-900">Aktifkan PPN</p>
                <p className="text-xs text-gray-400">Pajak akan ditampilkan & dihitung di kasir</p>
              </div>
              <button onClick={() => setSettings(s => ({ ...s, taxEnabled: !s.taxEnabled }))}
                className="text-gray-400 hover:text-indigo-600">
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
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-900">Pembulatan Harga</p>
                <p className="text-xs text-gray-400">Membulatkan total transaksi</p>
              </div>
              <button onClick={() => setSettings(s => ({ ...s, roundingEnabled: !s.roundingEnabled }))}
                className="text-gray-400 hover:text-indigo-600">
                {settings.roundingEnabled ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7" />}
              </button>
            </div>
            {settings.roundingEnabled && (
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tipe Pembulatan</label>
                <div className="flex gap-2">
                  {[
                    { val: 'nearest_500', label: 'Rp 500' },
                    { val: 'nearest_1000', label: 'Rp 1.000' },
                  ].map(({ val, label }) => (
                    <button key={val} onClick={() => setSettings(s => ({ ...s, roundingType: val as any }))}
                      className={`px-4 py-2 rounded-xl text-sm font-bold border-2 transition-all ${settings.roundingType === val ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-500'}`}>
                      {label}
                    </button>
                  ))}
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
            {[
              { key: 'headerText', label: 'Teks Header', placeholder: 'Nama toko / tagline' },
              { key: 'footerText', label: 'Teks Footer', placeholder: 'Pesan terima kasih' },
            ].map(({ key, label, placeholder }) => (
              <div key={key}>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{label}</label>
                <input type="text" value={settings.receipt[key as 'headerText' | 'footerText']}
                  onChange={e => setSettings(s => ({ ...s, receipt: { ...s.receipt, [key]: e.target.value } }))}
                  placeholder={placeholder}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            ))}
            {[
              { key: 'showTax', label: 'Tampilkan Pajak' },
              { key: 'showCashier', label: 'Tampilkan Nama Kasir' },
            ].map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between py-2">
                <p className="font-bold text-gray-900 text-sm">{label}</p>
                <button onClick={() => setSettings(s => ({ ...s, receipt: { ...s.receipt, [key]: !s.receipt[key as 'showTax' | 'showCashier'] } }))}
                  className="text-gray-400 hover:text-indigo-600">
                  {settings.receipt[key as 'showTax' | 'showCashier'] ? <ToggleRight className="w-6 h-6 text-indigo-600" /> : <ToggleLeft className="w-6 h-6" />}
                </button>
              </div>
            ))}
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
              <button onClick={() => setSettings(s => ({ ...s, autoOpenShift: !s.autoOpenShift }))}
                className="text-gray-400 hover:text-indigo-600">
                {settings.autoOpenShift ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7" />}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}