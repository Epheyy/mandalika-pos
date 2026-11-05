import { memo } from 'react'
import type { components } from '@mandalika/api'
import { normalizePhone } from '@mandalika/sync'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'
import { formatPoints, phoneHint } from './customerFinder'
import { knownTier } from './customerProfile'

type Customer = components['schemas']['Customer']

interface CustomerPickerProps {
  open: boolean
  onClose: () => void
  /** Customers matching the typed phone (the parent resolves them; the picker never filters by name). */
  customers: Customer[]
  /** "Terakhir dilayani di tablet ini": the tablet memory, already without the matches above. */
  recent: Customer[]
  customerSearch: string
  isAddingCustomer: boolean
  newCustomerForm: { name: string; phone: string; email: string }
  isSaving: boolean
  onSearchChange: (q: string) => void
  onSelect: (customer: Customer) => void
  onToggleAdding: () => void
  onNewFormChange: (field: 'name' | 'phone' | 'email', value: string) => void
  onSaveNew: () => void
  /** Switch to add-new, prefilling name/phone from the search query. */
  onAddNewFromSearch: (query: string) => void
  /** Error from the last save attempt (shown in the add form). */
  errorText?: string | null
  /** Loyalty is configurable in Backoffice; hide tier/points when off. */
  loyaltyEnabled: boolean
  /** The online phone lookup is still running (do not offer "add new" yet). */
  isSearching?: boolean
  /** Why the online lookup could not answer (e.g. the 429 budget message). */
  lookupError?: string | null
  /** A full phone is typed but not searched online yet: ask for Cari instead of offering add-new. */
  awaitingSearch?: boolean
  /** Explicit online search (Cari button / Enter). Typing alone never calls the server. */
  onSubmitSearch: () => void
  isOnline?: boolean
  /** Open the Profil Pelanggan sheet for a row (only when the brand has the profile feature). */
  onOpenProfile?: (customer: Customer) => void
}

const FIELD = 'w-full min-h-11 rounded-control border border-paper-2 bg-white px-3 text-[0.9375rem] focus:outline-none focus:ring-2 focus:ring-ink-900'

function Row({ c, loyaltyEnabled, onSelect, onOpenProfile }: { c: Customer; loyaltyEnabled: boolean; onSelect: (c: Customer) => void; onOpenProfile?: (c: Customer) => void }) {
  const tier = knownTier(c)
  return (
    <div className="flex items-stretch gap-2 border-b border-paper-2 last:border-0">
      <button type="button" onClick={() => onSelect(c)} className="flex min-h-14 min-w-0 flex-1 items-center justify-between gap-3 px-1 py-2 text-left active:bg-paper-1">
        <span className="min-w-0">
          <span className="block truncate text-[0.9375rem] font-semibold text-ink-900">{c.name}</span>
          <span className="flex flex-wrap items-center gap-x-1.5 text-[0.8125rem] text-ink-500">
            <span>{c.phone}</span>
            {tier && <span>· {tier}</span>}
            {loyaltyEnabled && <span>· {formatPoints(c.points)} poin</span>}
          </span>
        </span>
        <span aria-hidden="true" className="flex-shrink-0 text-[0.9375rem] font-semibold text-ink-900">Pilih ›</span>
      </button>
      {onOpenProfile && (
        <button type="button" onClick={() => onOpenProfile(c)} aria-label={`Profil ${c.name}`} className="touch flex-shrink-0 self-center rounded-control px-2 text-[0.8125rem] font-semibold text-ink-700 active:bg-paper-1">
          Profil
        </button>
      )}
    </div>
  )
}

/** W3 Pelanggan sheet (B3): phone field + Cari + "+ Baru", matches for the typed phone and the customers last
 *  served on this tablet. A side sheet over the cart column; the lookup and create rules are unchanged (A30). */
export const CustomerPicker = memo(function CustomerPicker({
  open, onClose, customers, recent, customerSearch, isAddingCustomer, newCustomerForm, isSaving,
  onSearchChange, onSelect, onToggleAdding, onNewFormChange, onSaveNew, onAddNewFromSearch, errorText, loyaltyEnabled,
  isSearching = false, lookupError = null, awaitingSearch = false, onSubmitSearch, isOnline = true, onOpenProfile,
}: CustomerPickerProps) {
  // A30: phone-only. Nothing is listed until the typed text is a full phone number.
  const hasPhone = normalizePhone(customerSearch) !== ''
  const hits = hasPhone ? customers : []
  const hint = phoneHint(customerSearch)
  const choose = (c: Customer) => {
    onSelect(c)
    onSearchChange('')
  }

  return (
    <Sheet
      open={open} onClose={onClose} variant="side" z={50} maxWidth="max-w-[486px]" panelClassName="flex flex-col overflow-hidden"
      title={<span className="block px-4 pt-4 pb-2 text-lg text-ink-900">Pelanggan</span>}
    >
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {isAddingCustomer ? (
          <div className="space-y-2">
            <p className="text-[0.9375rem] font-bold text-ink-900">Pelanggan Baru</p>
            <input className={FIELD} placeholder="Nama *" aria-label="Nama pelanggan" value={newCustomerForm.name} onChange={(e) => onNewFormChange('name', e.target.value)} />
            <input className={FIELD} placeholder="Telepon *" type="tel" inputMode="tel" aria-label="Nomor telepon pelanggan" value={newCustomerForm.phone} onChange={(e) => onNewFormChange('phone', e.target.value)} />
            <input className={FIELD} placeholder="Email (opsional)" aria-label="Email pelanggan (opsional)" value={newCustomerForm.email} onChange={(e) => onNewFormChange('email', e.target.value)} />
            {errorText && <p className="text-[0.8125rem] font-semibold text-danger">{errorText}</p>}
            <div className="flex gap-2">
              <Button variant="primary" onClick={onSaveNew} disabled={isSaving} className="flex-1">{isSaving ? 'Menyimpan…' : 'Simpan'}</Button>
              <Button variant="secondary" onClick={onToggleAdding} className="flex-1">Batal</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <input
                className={`${FIELD} flex-1`}
                placeholder="No. telepon pelanggan…"
                aria-label="Cari pelanggan dengan nomor telepon"
                type="tel" inputMode="tel" value={customerSearch}
                onChange={(e) => onSearchChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  if (hasPhone && !isSearching) onSubmitSearch()
                }}
              />
              <Button variant="primary" onClick={onSubmitSearch} disabled={!hasPhone || isSearching}>Cari</Button>
              <Button variant="secondary" onClick={onToggleAdding}>+ Baru</Button>
            </div>
            {hint && <p className="mt-2 text-[0.8125rem] text-ink-500">{hint}</p>}
            {hasPhone && !awaitingSearch && lookupError && <p className="mt-2 text-[0.8125rem] font-semibold text-warn">{lookupError}</p>}
            {hasPhone && awaitingSearch && hits.length === 0 && !isSearching && !lookupError && (
              <p className="mt-2 text-[0.8125rem] text-ink-500">Tekan Cari atau Enter untuk mencari pelanggan.</p>
            )}
            {hasPhone && !awaitingSearch && hits.length === 0 && !isSearching && !lookupError && (
              <button
                type="button" onClick={() => onAddNewFromSearch(customerSearch.trim())}
                className="mt-2 min-h-11 w-full rounded-control bg-paper-1 px-3 py-2 text-left text-[0.9375rem] font-semibold text-ink-900 active:bg-paper-2"
              >
                + Tambah “{customerSearch.trim()}” sebagai pelanggan baru
              </button>
            )}
            {hits.length > 0 && (
              <section aria-label="Cocok dengan nomor ini" className="mt-4">
                <h3 className="pb-1 text-[0.8125rem] font-semibold uppercase tracking-wide text-ink-500">Cocok dengan nomor ini</h3>
                {hits.map((c) => <Row key={c.id} c={c} loyaltyEnabled={loyaltyEnabled} onSelect={choose} onOpenProfile={onOpenProfile} />)}
              </section>
            )}
            {recent.length > 0 && (
              <section aria-label="Terakhir dilayani di tablet ini" className="mt-4">
                <h3 className="pb-1 text-[0.8125rem] font-semibold uppercase tracking-wide text-ink-500">Terakhir dilayani di tablet ini</h3>
                {recent.map((c) => <Row key={c.id} c={c} loyaltyEnabled={loyaltyEnabled} onSelect={choose} onOpenProfile={onOpenProfile} />)}
              </section>
            )}
            {!isOnline && (
              <p className="mt-4 text-[0.8125rem] text-ink-500">Offline: hanya pelanggan yang pernah dilayani di tablet ini yang bisa dicari.</p>
            )}
          </>
        )}
      </div>
      <div className="flex-shrink-0 border-t border-paper-2 p-3">
        <Button variant="secondary" onClick={onClose} className="w-full">Tutup</Button>
      </div>
    </Sheet>
  )
})
