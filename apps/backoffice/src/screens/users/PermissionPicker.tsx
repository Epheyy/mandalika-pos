import { Check } from 'lucide-react'

const PERMS: Record<string, { label: string; desc: string }> = {
  view_dashboard: { label: 'Lihat Dashboard', desc: 'Akses ringkasan & grafik' },
  view_transactions: { label: 'Lihat Transaksi', desc: 'Riwayat semua transaksi' },
  manage_products: { label: 'Kelola Produk', desc: 'Tambah, edit, hapus produk' },
  manage_customers: { label: 'Kelola Pelanggan', desc: 'Akses data pelanggan' },
  manage_outlets: { label: 'Kelola Outlet', desc: 'Tambah dan edit outlet' },
  manage_users: { label: 'Kelola Pengguna', desc: 'Atur role & akses' },
  process_refund: { label: 'Proses Refund', desc: 'Memproses pengembalian dana' },
  manage_promotions: { label: 'Kelola Promosi', desc: 'Buat dan edit promosi' },
  view_reports: { label: 'Lihat Laporan', desc: 'Akses laporan & export' },
  manage_settings: { label: 'Pengaturan', desc: 'Ubah konfigurasi sistem' },
  manage_stock_count: { label: 'Stock Count', desc: 'Kelola penghitungan stok' },
  manage_inventory: { label: 'Kelola Gudang', desc: 'Gudang, barang masuk & stok' },
  request_stock: { label: 'Ajukan Permintaan Barang', desc: 'Membuat dan mengirim permintaan barang dari outlet ke gudang' },
  resolve_sync_review: { label: 'Tinjauan Sinkron', desc: 'Melihat dan menyelesaikan item sinkron yang ditolak tablet (semua outlet)' },
}

interface PermissionPickerProps {
  selected: string[]
  onToggle: (perm: string) => void
  compact?: boolean
}

function PermissionPicker({ selected, onToggle, compact = false }: PermissionPickerProps) {
  if (compact) {
    return (
      <div className="space-y-1.5 max-h-48 overflow-y-auto">
        {Object.entries(PERMS).map(([p, { label }]) => (
          <button type="button" key={p} aria-pressed={selected.includes(p)} onClick={() => onToggle(p)} className={`w-full flex items-center gap-2 p-2.5 rounded-xl border-2 text-left ${selected.includes(p) ? 'border-brand-strong bg-paper-1' : 'border-gray-100'}`}>
            <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 ${selected.includes(p) ? 'bg-brand-strong' : 'border-2 border-gray-300'}`}>
              {selected.includes(p) && <Check className="w-2.5 h-2.5 text-on-brand" />}
            </div>
            <span className={`text-sm font-bold ${selected.includes(p) ? 'text-brand-strong' : 'text-gray-700'}`}>{label}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {Object.entries(PERMS).map(([p, { label, desc }]) => (
        <button type="button" key={p} aria-pressed={selected.includes(p)} onClick={() => onToggle(p)} className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left ${selected.includes(p) ? 'border-brand-strong bg-paper-1' : 'border-gray-100 hover:border-gray-200'}`}>
          <div className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 ${selected.includes(p) ? 'bg-brand-strong' : 'border-2 border-gray-300'}`}>
            {selected.includes(p) && <Check className="w-3 h-3 text-on-brand" />}
          </div>
          <div>
            <p className={`text-sm font-bold ${selected.includes(p) ? 'text-brand-strong' : 'text-gray-700'}`}>{label}</p>
            <p className="text-xs text-gray-400">{desc}</p>
          </div>
        </button>
      ))}
    </div>
  )
}

export { PERMS, PermissionPicker }
