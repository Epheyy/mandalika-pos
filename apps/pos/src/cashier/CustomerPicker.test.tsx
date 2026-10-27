import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CustomerPicker } from './CustomerPicker'

const alice = { id: 'a', name: 'Alice Priv', phone: '081234567890', points: 3, totalSpent: 0, visitCount: 0, createdAt: '2026-01-01T00:00:00Z' }

function render(over: Partial<Parameters<typeof CustomerPicker>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(CustomerPicker, {
      open: true,
      onClose: vi.fn(),
      customers: [],
      recent: [],
      customerSearch: '',
      isAddingCustomer: false,
      newCustomerForm: { name: '', phone: '', email: '' },
      isSaving: false,
      onSearchChange: vi.fn(),
      onSelect: vi.fn(),
      onToggleAdding: vi.fn(),
      onNewFormChange: vi.fn(),
      onSaveNew: vi.fn(),
      onAddNewFromSearch: vi.fn(),
      onSubmitSearch: vi.fn(),
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

  it('has a Cari button that is disabled until the text is a full phone', () => {
    expect(render({ customerSearch: '0812' })).toMatch(/<button[^>]*disabled=""[^>]*>Cari<\/button>/)
    const ready = render({ customerSearch: '081299998888' })
    expect(ready).toMatch(/<button[^>]*>Cari<\/button>/)
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Cari<\/button>/)
  })

  it('disables Cari while the online lookup runs', () => {
    expect(render({ customerSearch: '081299998888', isSearching: true })).toMatch(/<button[^>]*disabled=""[^>]*>Cari<\/button>/)
  })

  it('asks the cashier to search before offering add-new (no lookup while typing)', () => {
    const html = render({ customerSearch: '081299998888', customers: [], awaitingSearch: true })
    expect(html).toContain('Tekan Cari')
    expect(html).not.toContain('sebagai pelanggan baru')
  })
})

describe('CustomerPicker sections (B3)', () => {
  it('labels the matches and the customers last served on this tablet', () => {
    const bob = { ...alice, id: 'b', name: 'Bob Recent' }
    const html = render({ customerSearch: '081234567890', customers: [alice], recent: [bob] })
    expect(html).toContain('Cocok dengan nomor ini')
    expect(html).toContain('Terakhir dilayani di tablet ini')
    expect(html).toContain('Pilih ›')
    expect(html).toContain('Bob Recent')
  })

  it('shows the profile entry only when the screen wires it', () => {
    expect(render({ customerSearch: '081234567890', customers: [alice] })).not.toContain('Profil Alice Priv')
    expect(render({ customerSearch: '081234567890', customers: [alice], onOpenProfile: vi.fn() })).toContain('Profil Alice Priv')
  })

  it('says what offline can do', () => {
    expect(render({ isOnline: false })).toContain('Offline')
    expect(render({ isOnline: true })).not.toContain('Offline')
  })

  it('renders nothing while closed', () => {
    expect(render({ open: false })).toBe('')
  })
})
