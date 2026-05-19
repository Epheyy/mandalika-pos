import { memo, useEffect, useRef } from 'react'
import type { components } from '@mandalika/api'
import { getCustomerTier } from './pricing'

type Customer = components['schemas']['Customer']

interface CustomerPickerProps {
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
  /** Checkout was attempted without a customer — show a required hint. */
  required?: boolean
  /** Switch to add-new, prefilling name/phone from the search query. */
  onAddNewFromSearch: (query: string) => void
  /** Error from the last save attempt (shown in the add form). */
  errorText?: string | null
  /** Loyalty is configurable in Backoffice; hide tier/points when off. */
  loyaltyEnabled: boolean
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
  required,
  onAddNewFromSearch,
  errorText,
  loyaltyEnabled,
}: CustomerPickerProps) {
  const dropdownRef = useRef<HTMLDivElement>(null)

  const filteredCustomers =
    customerSearch.length >= 2
      ? customers
          .filter(
            (c) =>
              c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
              c.phone.includes(customerSearch),
          )
          .slice(0, 5)
      : []

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
            <p className="text-[10px] text-indigo-600">
              {selectedCustomer.phone}
              {loyaltyEnabled && (
                <>
                  {' · '}
                  {getCustomerTier(selectedCustomer.totalSpent)}
                  {' · '}
                  {selectedCustomer.points} poin
                </>
              )}
            </p>
            {loyaltyEnabled && earnedPoints > 0 && (
              <p className="text-[10px] text-green-600">
                +{earnedPoints} poin (tampilan sementara)
              </p>
            )}
          </div>
          <button
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
            value={newCustomerForm.name}
            onChange={(e) => onNewFormChange('name', e.target.value)}
          />
          <input
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            placeholder="Telepon *"
            type="tel"
            inputMode="tel"
            value={newCustomerForm.phone}
            onChange={(e) => onNewFormChange('phone', e.target.value)}
          />
          <input
            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            placeholder="Email (opsional)"
            value={newCustomerForm.email}
            onChange={(e) => onNewFormChange('email', e.target.value)}
          />
          {errorText && (
            <p className="text-[11px] font-semibold text-red-600">{errorText}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={onSaveNew}
              disabled={isSaving}
              className="flex-1 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50"
            >
              {isSaving ? 'Menyimpan…' : 'Simpan'}
            </button>
            <button
              onClick={onToggleAdding}
              className="flex-1 py-1.5 border border-gray-200 rounded-lg text-xs font-semibold text-gray-600"
            >
              Batal
            </button>
          </div>
        </div>
      ) : (
        <div className="relative">
          {required && (
            <p className="text-[11px] font-semibold text-red-600 mb-1">
              Pelanggan wajib dipilih sebelum checkout
            </p>
          )}
          <div className="flex gap-2">
            <input
              className={`flex-1 text-xs border rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 ${
                required ? 'border-red-300' : 'border-gray-200'
              }`}
              placeholder="Cari nama / no. telepon…"
              value={customerSearch}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            <button
              onClick={onToggleAdding}
              className="px-2 py-1.5 bg-gray-100 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-200 whitespace-nowrap"
            >
              + Baru
            </button>
          </div>
          {customerSearch.trim().length >= 2 &&
            filteredCustomers.length === 0 && (
              <button
                onClick={() => onAddNewFromSearch(customerSearch.trim())}
                className="mt-1 w-full text-left px-3 py-2 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-semibold hover:bg-indigo-100 transition-colors"
              >
                + Tambah “{customerSearch.trim()}” sebagai pelanggan baru
              </button>
            )}
          {filteredCustomers.length > 0 && (
            <div className="absolute top-full left-0 right-0 z-30 bg-white border border-gray-200 rounded-xl shadow-lg mt-1 overflow-hidden">
              {filteredCustomers.map((c) => (
                <button
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
                  <p className="text-[10px] text-gray-500">
                    {c.phone}
                    {loyaltyEnabled && ` · ${getCustomerTier(c.totalSpent)}`}
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
