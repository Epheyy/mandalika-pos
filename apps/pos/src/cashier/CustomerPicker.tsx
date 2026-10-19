import { memo, useEffect, useRef } from 'react'
import type { components } from '@mandalika/api'
import { normalizePhone } from '@mandalika/sync'
import { segmentChipClasses } from './segmentColors'
import { phoneHint } from './customerFinder'

type Customer = components['schemas']['Customer']

interface CustomerPickerProps {
  /** Customers matching the typed phone (the parent resolves them; the picker never filters by name). */
  customers: Customer[]
  selectedCustomer: Customer | null
  customerSearch: string
  isAddingCustomer: boolean
  newCustomerForm: { name: string; phone: string; email: string }
  isSaving: boolean
  onSearchChange: (q: string) => void
  onSelect: (customer: Customer) => void
  onClear: () => void
  onToggleAdding: () => void
  onNewFormChange: (field: 'name' | 'phone' | 'email', value: string) => void
  onSaveNew: () => void
  earnedPoints: number
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
}

export const CustomerPicker = memo(function CustomerPicker({
  customers,
  selectedCustomer,
  customerSearch,
  isAddingCustomer,
  newCustomerForm,
  isSaving,
  onSearchChange,
  onSelect,
  onClear,
  onToggleAdding,
  onNewFormChange,
  onSaveNew,
  earnedPoints,
  onAddNewFromSearch,
  errorText,
  loyaltyEnabled,
  isSearching = false,
  lookupError = null,
}: CustomerPickerProps) {
  const dropdownRef = useRef<HTMLDivElement>(null)

  // A30: phone-only. Nothing is listed until the typed text is a full phone number.
  const hasPhone = normalizePhone(customerSearch) !== ''
  const hits = hasPhone ? customers : []
  const hint = phoneHint(customerSearch)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        onSearchChange('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onSearchChange])

  if (selectedCustomer) {
    return (
      <div className="px-3 py-2 border-b border-gray-100 bg-indigo-50">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-indigo-800">
              {selectedCustomer.name}
            </p>
            <p className="text-[10px] text-indigo-600 flex items-center gap-1 flex-wrap">
              <span>{selectedCustomer.phone}</span>
              {selectedCustomer.segment && (
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${segmentChipClasses(selectedCustomer.segment.color)}`}>
                  {selectedCustomer.segment.name}
                </span>
              )}
              {loyaltyEnabled && <span>· {selectedCustomer.points} poin</span>}
            </p>
            {loyaltyEnabled && earnedPoints > 0 && (
              <p className="text-[10px] text-green-600">
                +{earnedPoints} poin (tampilan sementara)
              </p>
            )}
          </div>
          <button type="button"
            onClick={onClear}
            className="text-xs text-indigo-500 hover:text-indigo-700 ml-2"
          >
            ×
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="px-3 py-2 border-b border-gray-100" ref={dropdownRef}>
      {isAddingCustomer ? (
        <div className="space-y-2">
          <p className="text-xs font-bold text-gray-700">Pelanggan Baru</p>
          <input
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            placeholder="Nama *"
            aria-label="Nama pelanggan"
            value={newCustomerForm.name}
            onChange={(e) => onNewFormChange('name', e.target.value)}
          />
          <input
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            placeholder="Telepon *"
            type="tel"
            inputMode="tel"
            aria-label="Nomor telepon pelanggan"
            value={newCustomerForm.phone}
            onChange={(e) => onNewFormChange('phone', e.target.value)}
          />
          <input
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            placeholder="Email (opsional)"
            aria-label="Email pelanggan (opsional)"
            value={newCustomerForm.email}
            onChange={(e) => onNewFormChange('email', e.target.value)}
          />
          {errorText && (
            <p className="text-[11px] font-semibold text-red-600">{errorText}</p>
          )}
          <div className="flex gap-2">
            <button type="button"
              onClick={onSaveNew}
              disabled={isSaving}
              className="flex-1 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50"
            >
              {isSaving ? 'Menyimpan…' : 'Simpan'}
            </button>
            <button type="button"
              onClick={onToggleAdding}
              className="flex-1 py-1.5 border border-gray-200 rounded-lg text-xs font-semibold text-gray-600"
            >
              Batal
            </button>
          </div>
        </div>
      ) : (
        <div className="relative">
          <div className="flex gap-2">
            <input
              className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              placeholder="No. telepon pelanggan…"
              aria-label="Cari pelanggan dengan nomor telepon"
              type="tel"
              inputMode="tel"
              value={customerSearch}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            <button type="button"
              onClick={onToggleAdding}
              className="px-2 py-1.5 bg-gray-100 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-200 whitespace-nowrap"
            >
              + Baru
            </button>
          </div>
          {hint && <p className="mt-1 text-[11px] text-gray-500">{hint}</p>}
          {hasPhone && lookupError && (
            <p className="mt-1 text-[11px] font-semibold text-amber-700">{lookupError}</p>
          )}
          {hasPhone && hits.length === 0 && !isSearching && !lookupError && (
            <button type="button"
              onClick={() => onAddNewFromSearch(customerSearch.trim())}
              className="mt-1 w-full text-left px-3 py-2 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-semibold hover:bg-indigo-100 transition-colors"
            >
              + Tambah “{customerSearch.trim()}” sebagai pelanggan baru
            </button>
          )}
          {hits.length > 0 && (
            <div className="absolute top-full left-0 right-0 z-30 bg-white border border-gray-200 rounded-xl shadow-lg mt-1 overflow-hidden">
              {hits.map((c) => (
                <button type="button"
                  key={c.id}
                  onClick={() => {
                    onSelect(c)
                    onSearchChange('')
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-indigo-50 transition-colors border-b border-gray-50 last:border-0"
                >
                  <p className="text-xs font-semibold text-gray-800">
                    {c.name}
                  </p>
                  <p className="text-[10px] text-gray-500 flex items-center gap-1 flex-wrap">
                    <span>{c.phone}</span>
                    {c.segment && (
                      <span className={`px-1 py-0.5 rounded-full text-[9px] font-bold ${segmentChipClasses(c.segment.color)}`}>
                        {c.segment.name}
                      </span>
                    )}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
