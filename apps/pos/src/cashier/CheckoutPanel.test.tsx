import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CheckoutPanel } from './CheckoutPanel'

type Props = ComponentProps<typeof CheckoutPanel>

const noop = () => {}
const DERIVED = {
  subtotal: 1300000,
  manualDiscountAmount: 0,
  promoDiscountAmount: 49000,
  appliedPromoDiscountAmount: 49000,
  appliedManualDiscountAmount: 0,
  discountAmount: 49000,
  taxableAmount: 1251000,
  taxAmount: 0,
  surchargeAmount: 0,
  redeemAmount: 0,
  redeemedPoints: 0,
  total: 1251000,
  earnedPoints: 0,
  totalCartItems: 1,
}
const SETTINGS = {
  paymentMethods: [
    { id: 'cash', label: 'Tunai', isEnabled: true },
    { id: 'qris', label: 'QRIS', isEnabled: true },
  ],
} as unknown as Props['settings']
const CUSTOMER = { id: 'c1', name: 'Budi Santoso', phone: '0812' } as unknown as Props['selectedCustomer']

const props = (over: Partial<Props> = {}): Props => ({
  isOpen: true,
  isProcessing: false,
  derived: DERIVED,
  totalRows: [
    { key: 'subtotal', kind: 'subtotal', label: 'Subtotal', amount: 1300000 },
    { key: 'promo-0', kind: 'promo', label: 'Diskon', amount: -49000 },
    { key: 'total', kind: 'total', label: 'TOTAL', amount: 1251000 },
  ],
  settings: SETTINGS,
  paymentMethod: 'cash',
  amountPaid: '',
  selectedCustomer: null,
  orderNotes: '',
  salesmen: [],
  selectedSalesmanId: null,
  onSelectSalesman: noop,
  loyaltyEnabled: true,
  customerPoints: 0,
  rewards: [],
  rewardsLoading: false,
  stockProducts: [],
  pickedRewards: {},
  onPickReward: noop,
  onClearReward: noop,
  pointsToRedeem: 0,
  onPointsRedeemedChange: noop,
  onPaymentMethodChange: noop,
  onAmountPaidChange: noop,
  tenderReference: '',
  onTenderReferenceChange: noop,
  splitMode: false,
  tenders: [],
  onSplitStart: noop,
  onSplitCancel: noop,
  onTenderAdd: noop,
  onTenderRemove: noop,
  onConfirm: noop,
  onClose: noop,
  allowNegativeStock: true,
  cartLines: [],
  ...over,
})
const html = (over?: Partial<Props>) => renderToStaticMarkup(createElement(CheckoutPanel, props(over)))

describe('CheckoutPanel (F2: Bayar in the Kaca layout)', () => {
  it('drops the third TOTAL row (the header and Konfirmasi carry the total), subtotal and promo rows stay', () => {
    const out = html()
    expect(out).not.toContain('>TOTAL<')
    expect(out).toContain('Subtotal')
    expect(out).toContain('Diskon')
  })

  it('renders the payment methods as one segmented group of pressed/unpressed buttons', () => {
    const out = html()
    expect(out).toContain('role="group" aria-label="Metode pembayaran"')
    expect(out).toMatch(/aria-pressed="true"[^>]*>Tunai</)
    expect(out).toMatch(/aria-pressed="false"[^>]*>QRIS</)
    expect(out).not.toContain('>Metode Pembayaran<')
  })

  it('labels the quick-cash chips without "Rp" and keeps "Uang pas" first and pressed for an empty field', () => {
    const out = html()
    expect(out).toMatch(/aria-pressed="true"[^>]*>Uang pas</)
    expect(out).toContain('>1.300.000<')
    expect(out).toContain('>1.500.000<')
    expect(out).not.toMatch(/>Rp\s1\.500\.000</)
  })

  it('names the Konfirmasi button "Konfirmasi Rp …" (scenarios find it by /^Konfirmasi Rp/) and drops the footnote', () => {
    const out = html()
    const label = out.match(/<button[^>]*>(<span[^>]*>Konfirmasi<\/span> <span[^>]*>[^<]*<\/span>)<\/button>/)
    expect(label).not.toBeNull()
    expect(label![1].replace(/<[^>]+>/g, '').replace(/\s/g, ' ')).toBe('Konfirmasi Rp 1.251.000')
    expect(out).not.toContain('Order akan terkirim otomatis')
  })

  it('names the customer once: in the loyalty card when it shows, in the grey card when it does not', () => {
    const withCard = html({ selectedCustomer: CUSTOMER, customerPoints: 120 })
    expect(withCard.match(/Budi Santoso/g)).toHaveLength(1)
    expect(withCard).toContain('Tukar 120 poin')
    const withoutCard = html({ selectedCustomer: CUSTOMER, loyaltyEnabled: false })
    expect(withoutCard.match(/Budi Santoso/g)).toHaveLength(1)
    expect(withoutCard).toContain('0812')
  })

  it('shows a single-choice reward as one tap chip with no fold-out, a multi-choice one as a fold-out', () => {
    const reward = (variants: { size: string; price: number }[]) =>
      ({ conditionId: 'k1', conditionName: 'Hadiah tas', rewardProductIds: ['p1'], products: [{ id: 'p1', name: 'Tas Kanvas', variants }] }) as unknown as Props['rewards'][number]
    const single = html({ selectedCustomer: CUSTOMER, customerPoints: 1, rewards: [reward([{ size: '', price: 0 }])] })
    expect(single).toContain('Tas Kanvas')
    expect(single).toContain('Tersedia!')
    expect(single).not.toContain('Hadiah tas')
    const multi = html({ selectedCustomer: CUSTOMER, customerPoints: 1, rewards: [reward([{ size: 'M', price: 0 }, { size: 'L', price: 0 }])] })
    expect(multi).toContain('Hadiah tas')
  })
})
