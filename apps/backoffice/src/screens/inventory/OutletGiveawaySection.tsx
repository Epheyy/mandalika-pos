import { useState } from 'react'
import { ApiError, type Product } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { useCachedList } from '../../hooks/useCachedList'
import { productCatalogue } from '../../lib/productCatalogue'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Field'

const REFRESH_MS = 60_000

interface Draft {
  productId: string
  variantSize: string
  enabled: boolean
}

// "Hadiah per transaksi": one unit of this item leaves the outlet's stock with every
// completed sale (the canvas bag). It is a ledger movement only: the tablet shows nothing,
// the refund never gives it back, and the ERP receives it as a plain Rp0 sale line.
export function OutletGiveawaySection({ outletId }: { outletId: string }) {
  const q = usePolledQuery(
    async () => {
      // The stock read needs manage_inventory: a 403 leaves a manage_outlets-only user able to
      // configure the giveaway, with "—" for the stock.
      const [giveaway, stock] = await Promise.all([
        api.getOutletGiveaway(outletId),
        api.getTransferLocationStock('outlet', outletId).catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 403) return null // no manage_inventory: stock shows "—"
          throw e // anything else is a real load error
        }),
      ])
      return { giveaway, stock }
    },
    [outletId],
    REFRESH_MS,
  )
  // The product list is the shared catalogue (not part of this 60 s poll).
  const catalogue = useCachedList(productCatalogue)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  if ((q.loading && !q.data) || (catalogue.loading && !catalogue.data)) return <p className="text-xs text-gray-500">Memuat hadiah per transaksi…</p>
  if (!q.data || !catalogue.data) return <p className="text-sm text-red-600">{q.error ?? catalogue.error ?? 'Gagal memuat hadiah per transaksi.'}</p>

  const { giveaway, stock } = q.data
  // The configured item stays selectable even when it is no longer in the catalogue (name from the setting).
  const listed = catalogue.data
  const products =
    giveaway.productId && !listed.some((p) => p.id === giveaway.productId)
      ? [
          ...listed,
          {
            id: giveaway.productId,
            name: giveaway.productName ?? giveaway.productId,
            variants: giveaway.variantSize ? [{ size: giveaway.variantSize, sku: giveaway.sku ?? '' }] : [],
          } as Product,
        ]
      : listed
  const saved: Draft = {
    productId: giveaway.productId ?? '',
    variantSize: giveaway.variantSize ?? '',
    enabled: giveaway.configured ? giveaway.enabled : false,
  }
  const cur = draft ?? saved
  const product = products.find((p) => p.id === cur.productId)
  const variant = product?.variants.find((v) => v.size === cur.variantSize)
  const unchanged = !draft || (draft.productId === saved.productId && draft.variantSize === saved.variantSize && draft.enabled === saved.enabled)
  const bagStock = stock?.find((s) => s.productId === cur.productId && s.variantSize === cur.variantSize)?.stock
  // The saved setting knows its mapping; a freshly picked variant is judged by the catalog row.
  const savedSame = giveaway.configured && cur.productId === saved.productId && cur.variantSize === saved.variantSize
  const mapped = savedSame ? giveaway.erpMapped === true : !!variant?.erpSlug && !!variant.sku
  const invalid = giveaway.configured && savedSame && giveaway.valid === false

  const save = async () => {
    if (!cur.productId || !cur.variantSize) {
      setMsg({ ok: false, text: 'Pilih produk dan ukuran hadiah.' })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await api.setOutletGiveaway(outletId, cur, crypto.randomUUID())
      setDraft(null)
      await q.refetch()
      setMsg({ ok: true, text: 'Tersimpan.' })
    } catch (e: unknown) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Gagal menyimpan.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Hadiah per transaksi" className="rounded-xl border border-gray-200 p-3 space-y-3">
      <div>
        <h3 className="text-sm font-bold text-gray-800">Hadiah per transaksi</h3>
        <p className="text-xs text-gray-500 mt-1">
          Satu unit item ini dikurangkan dari stok outlet pada setiap transaksi selesai (mis. tas kanvas), termasuk transaksi Rp0.
          Tidak dikembalikan saat refund, tidak tampil di kasir, dan dikirim ke ERP sebagai baris penjualan Rp0 biasa.
        </p>
      </div>
      <Select
        label="Produk hadiah"
        value={cur.productId}
        onChange={(e) => setDraft({ ...cur, productId: e.target.value, variantSize: '' })}
      >
        <option value="">— Pilih produk —</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <Select
        label="Ukuran"
        value={cur.variantSize}
        disabled={!product}
        onChange={(e) => setDraft({ ...cur, variantSize: e.target.value })}
      >
        <option value="">— Pilih ukuran —</option>
        {(product?.variants ?? []).map((v) => (
          <option key={v.size} value={v.size}>
            {v.size}
          </option>
        ))}
      </Select>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={cur.enabled}
          onChange={(e) => setDraft({ ...cur, enabled: e.target.checked })}
          className="w-4 h-4 accent-gold-600"
        />
        <span className="text-sm font-bold text-gray-700">Hadiah aktif</span>
      </label>
      {cur.productId && cur.variantSize && (
        <ul className="text-xs space-y-0.5">
          <li className={invalid ? 'text-red-600 font-bold' : 'text-gray-600'}>
            {invalid ? 'Varian tidak valid (sudah dihapus): hadiah dilewati.' : `Stok hadiah saat ini: ${stock ? (bagStock ?? 0) : '—'}`}
          </li>
          <li className={mapped ? 'text-green-700' : 'text-red-600 font-bold'}>
            {mapped ? 'Sudah dipetakan ke ERP' : 'Belum dipetakan ke ERP'}
          </li>
        </ul>
      )}
      {msg && <p className={`text-xs ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</p>}
      <Button size="sm" onClick={save} loading={busy} disabled={unchanged}>
        Simpan Hadiah
      </Button>
    </section>
  )
}
