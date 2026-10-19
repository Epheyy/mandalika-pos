import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CustomerPicker } from './CustomerPicker'

const alice = { id: 'a', name: 'Alice Priv', phone: '081234567890', points: 3, totalSpent: 0, visitCount: 0, createdAt: '2026-01-01T00:00:00Z' }

function render(over: Partial<Parameters<typeof CustomerPicker>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(CustomerPicker, {
      customers: [],
      selectedCustomer: null,
      customerSearch: '',
      isAddingCustomer: false,
      newCustomerForm: { name: '', phone: '', email: '' },
      isSaving: false,
      onSearchChange: vi.fn(),
      onSelect: vi.fn(),
      onClear: vi.fn(),
      onToggleAdding: vi.fn(),
      onNewFormChange: vi.fn(),
      onSaveNew: vi.fn(),
      earnedPoints: 0,
      onAddNewFromSearch: vi.fn(),
      loyaltyEnabled: true,
      ...over,
    }),
  )
}

// A30: the cashier finds a customer by full phone number only. The picker shows exactly the hits
// it is given (no name filtering of its own) and never a list.
describe('CustomerPicker phone-only search', () => {
  it('is a phone input', () => {
    const html = render()
    expect(html).toContain('placeholder="No. telepon pelanggan')
    expect(html).toContain('inputMode="tel"')
    expect(html).not.toContain('Cari nama')
  })

  it('shows nothing for a typed name and asks for the phone', () => {
    const html = render({ customerSearch: 'Alice' })
    expect(html).not.toContain('Alice Priv')
    expect(html).toContain('nomor telepon')
    expect(html).not.toContain('sebagai pelanggan baru')
  })

  it('shows the cache or online hit for a valid phone', () => {
    const html = render({ customerSearch: '+62 812 3456 7890', customers: [alice] })
    expect(html).toContain('Alice Priv')
    expect(html).toContain('081234567890')
    expect(html).not.toContain('sebagai pelanggan baru')
  })

  it('offers to add a new customer with the typed phone when nothing matches', () => {
    const html = render({ customerSearch: '081299998888', customers: [] })
    expect(html).toContain('081299998888')
    expect(html).toContain('sebagai pelanggan baru')
  })

  it('does not offer to add while the online lookup is still running', () => {
    const html = render({ customerSearch: '081299998888', customers: [], isSearching: true })
    expect(html).not.toContain('sebagai pelanggan baru')
  })

  it('shows the busy message after a 429', () => {
    const html = render({ customerSearch: '081299998888', lookupError: 'Terlalu banyak pencarian, coba lagi sebentar.' })
    expect(html).toContain('coba lagi sebentar')
    expect(html).not.toContain('sebagai pelanggan baru')
  })

  it('does not filter the hits it is given by name', () => {
    const html = render({ customerSearch: '081234567890', customers: [{ ...alice, name: 'Zed' }] })
    expect(html).toContain('Zed')
  })
})
