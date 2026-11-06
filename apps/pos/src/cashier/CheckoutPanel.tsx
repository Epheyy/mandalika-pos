import { memo, useState } from 'react'
import type { components } from '@mandalika/api'
import type { CartDerived } from '../hooks/useCart'
import { isCashMethod } from '@mandalika/types'
import { formatRupiah } from './pricing'
import { cashTender } from './tender'
import { stockFor, overstockLines } from './stock'
import type { CartLineLike } from './stock'
import { PAYMENT_LABELS, tenderLabel } from '../lib/paymentLabels'
import { quickCashAmounts } from '../lib/quickCash'
import { applyKey } from '../lib/cashKeypad'
import { hasFeature } from '../brand'
import { Sheet } from '../components/ui/Sheet'
import { ReceiptTotals } from './ReceiptTotals'
import type { TotalRow } from './receiptRows'
import { Chip } from '../components/ui/Chip'
import { Button } from '../components/ui/Button'
import { IconUser, IconGift, IconWarning } from '../components/ui/icons'
import { SplitTenderSection } from './SplitTenderSection'
import { allocateTenders, cashPredicate, isCovered, MAX_REFERENCE_LEN, splitBlockReason, type TenderLine } from './tenderSplit'
import { useCashField } from './cashInput'

type AppSettings = components['schemas']['AppSettings']
type Customer = components['schemas']['Customer']
type LoyaltyPreviewReward = components['schemas']['LoyaltyPreviewReward']
type Product = components['schemas']['Product']

type PaymentMethod = string

interface CheckoutPanelProps {
  isOpen: boolean
  isProcessing: boolean
  derived: CartDerived
  /** The same rows the printed receipt will show (C1 follow-up), from receiptRows.quoteTotalRows. */
  totalRows: TotalRow[]
  settings: AppSettings
  paymentMethod: PaymentMethod
  amountPaid: string
  selectedCustomer: Customer | null
  orderNotes: string
  salesmen: { id: string; name: string }[]
  selectedSalesmanId: string | null
  onSelectSalesman: (salesman: { id: string; name: string } | null) => void
  loyaltyEnabled: boolean
  customerPoints: number
  rewards: LoyaltyPreviewReward[]
  rewardsLoading: boolean
  stockProducts: Product[]
  pickedRewards: Record<string, { productId: string; variantSize: string }>
  onPickReward: (
    conditionId: string,
    product: { id: string; name: string },
    variant: { size: string; price: number },
  ) => void
  onClearReward: (conditionId: string) => void
  pointsToRedeem: number
  onPointsRedeemedChange: (points: number) => void
  onPaymentMethodChange: (method: PaymentMethod) => void
  onAmountPaidChange: (amount: string) => void
  /** C6: the optional "No. referensi" of the line being composed (single mode: of the one payment). */
  tenderReference: string
  onTenderReferenceChange: (reference: string) => void
  /** C6: split mode and its entered lines; "Bagi pembayaran" is offered only when the server delivers the setting as true. */
  splitMode: boolean
  tenders: readonly TenderLine[]
  onSplitStart: () => void
  onSplitCancel: () => void
  onTenderAdd: (line: TenderLine) => void
  onTenderRemove: (index: number) => void
  onConfirm: () => void
  /** Persistent error shown when the sale could not be stored on the device. */
  saveError?: string | null
  onClose: () => void
  allowNegativeStock: boolean
  cartLines: CartLineLike[]
  /** False while the device cannot reach the server: loyalty rewards need it. Defaults to true. */
  isOnline?: boolean
}

const noop = () => {}

const KEYPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0', '⌫'] as const


export const CheckoutPanel = memo(function CheckoutPanel({
  isOpen,
  isProcessing,
  derived,
  totalRows,
  settings,
  paymentMethod,
  amountPaid,
  selectedCustomer,
  orderNotes,
  salesmen,
  selectedSalesmanId,
  onSelectSalesman,
  loyaltyEnabled,
  customerPoints,
  rewards,
  rewardsLoading,
  stockProducts,
  pickedRewards,
  onPickReward,
  onClearReward,
  pointsToRedeem,
  onPointsRedeemedChange,
  onPaymentMethodChange,
  onAmountPaidChange,
  tenderReference,
  onTenderReferenceChange,
  splitMode,
  tenders,
  onSplitStart,
  onSplitCancel,
  onTenderAdd,
  onTenderRemove,
  onConfirm,
  saveError,
  onClose,
  allowNegativeStock,
  cartLines,
  isOnline = true,
}: CheckoutPanelProps) {
  // SP-CRM-9b: per-condition expand state; collapsed by default so a generous
  // menu doesn't flood the checkout. Picking auto-collapses.
  const [openRewards, setOpenRewards] = useState<Record<string, boolean>>({})
  // SP-CRM-9c: overstock confirm modal state
  const [showOverstockConfirm, setShowOverstockConfirm] = useState(false)
  // The points redeem UI sits behind the "Tukar N poin" chip; open from the start when points are already applied.
  const [userOpenedPoints, setUserOpenedPoints] = useState(false)
  // D-63: leaving with payment lines already entered asks first.
  const [confirmLeave, setConfirmLeave] = useState(false)
  const cashField = useCashField(amountPaid, onAmountPaidChange)
  const showPoints = pointsToRedeem > 0 || userOpenedPoints
  // Forget the manual open when the sheet closes so it does not carry into the next sale.
  const [wasOpen, setWasOpen] = useState(isOpen)
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen)
    if (!isOpen) setUserOpenedPoints(false)
  }

  if (!isOpen) return null

  const enabledMethods = settings.paymentMethods.filter((m) => m.isEnabled)
  const isCash = isCashMethod(settings.paymentMethods, paymentMethod)
  const tender = cashTender(isCash, amountPaid, derived.total)
  const isCashShort = tender.isShort
  // C6: split mode is offered only when the server says so (an old server never sends the key) and there is more than one method.
  const splitOffered = settings.splitTenderEnabled === true && enabledMethods.length >= 2
  const splitBlock = splitMode
    ? splitBlockReason(derived.total, tenders, cashPredicate(settings.paymentMethods), (id) => tenderLabel(id, settings.paymentMethods))
    : null
  const confirmBlocked = splitMode ? splitBlock !== null : isCashShort
  // Kembalian lives in the sticky bar next to Konfirmasi: the single cash tender's change, or the settled split's.
  const splitSettled =
    splitMode && isCovered(derived.total, tenders) ? allocateTenders(derived.total, tenders, cashPredicate(settings.paymentMethods), 'batch') : null
  const barChange = splitMode ? (splitSettled?.ok ? splitSettled.settlement.change : 0) : tender.change
  const handleBack = () => {
    if (splitMode && tenders.length > 0) setConfirmLeave(true)
    else onClose()
  }

  const quickAmounts = quickCashAmounts(derived.total)
  const typedAmount = amountPaid.trim() === '' ? null : parseFloat(amountPaid.replace(/\./g, ''))

  // SP-CRM-9c: overstock guard — overstockLines returns [] when allowNegativeStock is true
  const overstock = overstockLines(cartLines, stockProducts, allowNegativeStock)
  const handleConfirmClick = () => {
    if (overstock.length > 0) {
      setShowOverstockConfirm(true)
      return
    }
    onConfirm()
  }

  const showLoyaltyCard =
    hasFeature('loyalty') && loyaltyEnabled && !!selectedCustomer && (!isOnline || rewardsLoading || rewards.length > 0 || customerPoints > 0)

  return (
    <Sheet
      open
      variant="side"
      z={50}
      maxWidth="max-w-md lg:max-w-[486px]"
      panelClassName="flex flex-col"
      onClose={isProcessing ? noop : handleBack}
      header
      title={
        <>
          Bayar{' '}
          <span aria-hidden="true" className="ml-3 tnum">
            {formatRupiah(derived.total)}
          </span>
        </>
      }
    >
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {/* Totals summary */}
        <div className="bg-paper-1 rounded-control p-4 space-y-2 text-sm">
          <ReceiptTotals rows={totalRows} />
        </div>

        {/* Customer info */}
        {selectedCustomer && (
          <div className="flex items-center gap-2 p-3 bg-paper-1 rounded-control text-xs">
            <span className="text-ink-500"><IconUser size={12} /></span>
            <div>
              <p className="font-semibold text-ink-900">{selectedCustomer.name}</p>
              <p className="text-ink-500">{selectedCustomer.phone}</p>
            </div>
          </div>
        )}

        {/* Notes */}
        {orderNotes && (
          <div className="p-3 bg-warn-bg rounded-control text-xs text-ink-700">
            <span className="font-semibold">Catatan: </span>
            {orderNotes}
          </div>
        )}

        {/* Hadiah & Poin: loyalty rewards (online-only) and points redemption */}
        {showLoyaltyCard && selectedCustomer && (
          <div className="rounded-sheet bg-reward-bg p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-reward">
                <IconGift size={14} className="inline-block align-[-0.125em]" /> Hadiah &amp; Poin · {selectedCustomer.name}
              </p>
              <span className="text-sm font-bold tnum text-reward shrink-0">{customerPoints} poin</span>
            </div>
            {!isOnline && <p className="text-xs font-semibold text-reward">Butuh internet</p>}
            {isOnline && rewardsLoading && <p className="text-xs text-reward">Memeriksa hadiah…</p>}
            {isOnline &&
              rewards.map((rw) => {
                const picked = pickedRewards[rw.conditionId]
                const pickedProduct = picked ? rw.products.find((p) => p.id === picked.productId) : undefined
                const isExpanded = openRewards[rw.conditionId] ?? false
                return (
                  <div key={rw.conditionId} className="rounded-control bg-white p-3">
                    <button
                      type="button"
                      onClick={() => setOpenRewards((o) => ({ ...o, [rw.conditionId]: !isExpanded }))}
                      className="w-full min-h-11 flex items-center justify-between gap-2"
                    >
                      <span className="text-sm font-semibold text-ink-900 text-left">{rw.conditionName}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {!picked && <span className="text-xs font-bold text-ok">Tersedia!</span>}
                        <span className="text-ink-500 text-xs">{isExpanded ? '▲' : '▼'}</span>
                      </span>
                    </button>
                    {picked && !isExpanded && (
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <Chip selected tone="reward">
                          ✓ {pickedProduct?.name ?? ''}
                          {picked.variantSize ? ` · ${picked.variantSize}` : ''} · GRATIS
                        </Chip>
                        <span className="flex gap-3 shrink-0">
                          <button
                            type="button"
                            onClick={() => setOpenRewards((o) => ({ ...o, [rw.conditionId]: true }))}
                            className="min-h-12 text-xs font-semibold text-reward underline"
                          >
                            Ganti
                          </button>
                          <button
                            type="button"
                            onClick={() => onClearReward(rw.conditionId)}
                            className="min-h-12 text-xs font-semibold text-reward underline"
                          >
                            Hapus
                          </button>
                        </span>
                      </div>
                    )}
                    {isExpanded && (
                      <>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {rw.products.flatMap((p) =>
                            p.variants.map((v) => {
                              const isSel = picked?.productId === p.id && picked?.variantSize === v.size
                              const st = stockFor(stockProducts, p.id, v.size)
                              return (
                                <Chip
                                  key={`${p.id}-${v.size}`}
                                  selected={isSel}
                                  tone="reward"
                                  onClick={() => {
                                    onPickReward(rw.conditionId, { id: p.id, name: p.name }, v)
                                    setOpenRewards((o) => ({ ...o, [rw.conditionId]: false }))
                                  }}
                                >
                                  {isSel ? '✓ ' : ''}
                                  {p.name}
                                  {v.size ? ` · ${v.size}` : ''}
                                  {isSel ? ' · GRATIS' : ''}
                                  {st === null ? null : (
                                    <span className={st > 0 ? 'opacity-80' : 'font-bold text-danger'}>· Stok {st}</span>
                                  )}
                                </Chip>
                              )
                            }),
                          )}
                        </div>
                        {picked && (
                          <button
                            type="button"
                            onClick={() => onClearReward(rw.conditionId)}
                            className="mt-1 min-h-12 text-xs font-semibold text-reward underline"
                          >
                            Batalkan hadiah
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )
              })}

            {customerPoints > 0 && (
              <div>
                <Chip tone="reward" toggle={false} onClick={() => setUserOpenedPoints((o) => !o)} className="!border-reward text-reward">
                  Tukar {customerPoints} poin ›
                </Chip>
                {showPoints && (
                  <div className="mt-2 rounded-control bg-white p-3">
                    <p className="text-xs font-semibold text-ink-700 mb-2">Tukar Poin Loyalti</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={customerPoints}
                        value={pointsToRedeem || ''}
                        onChange={(e) =>
                          onPointsRedeemedChange(Math.min(customerPoints, Math.max(0, parseInt(e.target.value) || 0)))
                        }
                        placeholder="0"
                        aria-label="Jumlah poin yang ditukar"
                        className="flex-1 min-h-11 border border-paper-2 rounded-control px-3 text-sm focus:outline-none focus:ring-1 focus:ring-reward"
                      />
                      <button
                        type="button"
                        onClick={() => onPointsRedeemedChange(customerPoints)}
                        className="min-h-11 px-4 bg-reward-bg text-reward rounded-control text-xs font-semibold"
                      >
                        Semua
                      </button>
                    </div>
                    <p className="text-xs text-ink-500 mt-1">
                      Tersedia {customerPoints} poin
                      {pointsToRedeem > 0 && derived.redeemAmount > 0
                        ? ` · potongan ${formatRupiah(derived.redeemAmount)}`
                        : ''}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {splitMode ? (
          <SplitTenderSection
            due={derived.total}
            allMethods={settings.paymentMethods}
            enabledMethods={enabledMethods}
            lines={tenders}
            method={paymentMethod}
            amountInput={amountPaid}
            reference={tenderReference}
            disabled={isProcessing}
            onMethodChange={onPaymentMethodChange}
            onAmountChange={onAmountPaidChange}
            onReferenceChange={onTenderReferenceChange}
            onAdd={onTenderAdd}
            onCancel={onSplitCancel}
            onRemove={onTenderRemove}
          />
        ) : (
          <>
        {/* Payment method */}
        <div>
          <p className="text-xs font-semibold text-ink-700 mb-2">Metode Pembayaran</p>
          <div className="flex gap-2">
            {enabledMethods.map((m) => (
              <Chip
                key={m.id}
                selected={paymentMethod === m.id}
                onClick={() => onPaymentMethodChange(m.id)}
                className="flex-1 justify-center !min-h-14 !px-2 !text-base"
              >
                {PAYMENT_LABELS[m.id] ?? m.label}
              </Chip>
            ))}
          </div>
          {splitOffered && (
            <button
              type="button"
              onClick={onSplitStart}
              className="mt-2 min-h-12 text-sm font-semibold text-brand underline"
            >
              Bagi pembayaran
            </button>
          )}
        </div>

        {/* Amount received (cash) or the bill (non-cash) */}
        {isCash ? (
          <div>
            <label htmlFor="checkout-amount" className="block text-sm font-semibold text-ink-700 mb-2">
              Diterima dari pelanggan
            </label>
            <input
              id="checkout-amount"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              {...cashField}
              placeholder={formatRupiah(derived.total)}
              aria-label="Jumlah dibayar"
              className="w-full h-16 border-2 border-ink-700 rounded-control px-4 text-[2rem] font-bold tnum text-ink-900 focus:outline-none"
            />
            <div className="flex gap-2 flex-wrap mt-2">
              {quickAmounts.map((amt, i) => (
                <Chip
                  key={amt}
                  selected={typedAmount === amt || (i === 0 && typedAmount === null)}
                  onClick={() => onAmountPaidChange(String(amt))}
                >
                  {i === 0 ? 'Uang pas' : formatRupiah(amt)}
                </Chip>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 mt-3">
              {KEYPAD_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => onAmountPaidChange(applyKey(amountPaid, k))}
                  aria-label={k === '⌫' ? 'Hapus satu angka' : undefined}
                  className="h-12 rounded-control bg-paper-1 text-lg font-semibold tnum text-ink-900 active:bg-paper-2"
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <p className="text-base font-semibold text-ink-700">
              Tagihan <span className="tnum text-ink-900">{formatRupiah(derived.total)}</span>
            </p>
            <div>
              <label htmlFor="checkout-reference" className="block text-xs font-semibold text-ink-700 mb-1">No. referensi (opsional)</label>
              <input
                id="checkout-reference"
                type="text"
                maxLength={MAX_REFERENCE_LEN}
                value={tenderReference}
                onChange={(e) => onTenderReferenceChange(e.target.value)}
                className="w-full min-h-11 border border-paper-2 rounded-control px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand bg-white"
              />
            </div>
          </>
        )}
          </>
        )}
      </div>

      {/* Sticky bar: Sales (opsional) as a small row, Kembalian / Kurang next to Konfirmasi */}
      <div className="px-5 pt-3 pb-4 border-t border-paper-2 shrink-0 space-y-3">
        {saveError && (
          <p role="alert" className="text-xs font-semibold text-danger bg-danger-bg rounded-control px-3 py-2">
            {saveError}
          </p>
        )}
        {salesmen.length > 0 && (
          <div className="flex items-center gap-3">
            <label htmlFor="checkout-salesman" className="text-xs font-semibold text-ink-700 shrink-0">
              Sales (opsional)
            </label>
            <select
              id="checkout-salesman"
              value={selectedSalesmanId ?? ''}
              onChange={(e) => {
                const s = salesmen.find((x) => x.id === e.target.value)
                onSelectSalesman(s ? { id: s.id, name: s.name } : null)
              }}
              className="flex-1 min-w-0 min-h-11 border border-paper-2 rounded-control px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand bg-white"
            >
              <option value="">— Tanpa sales —</option>
              {salesmen.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-3">
          <div aria-live="polite" aria-atomic="true" className="shrink-0">
            {barChange > 0 && (
              <>
                <p className="text-xs text-ink-700">Kembalian</p>
                <p className="text-xl font-bold tnum text-ok">{formatRupiah(barChange)}</p>
              </>
            )}
            {!splitMode && isCashShort && (
              <>
                <p className="text-xs text-ink-700">Kurang</p>
                <p className="text-xl font-bold tnum text-danger">{formatRupiah(derived.total - tender.amountPaid)}</p>
              </>
            )}
          </div>
          <Button size="lg" className="flex-1 !text-lg font-bold" onClick={handleConfirmClick} disabled={isProcessing || confirmBlocked}>
            {isProcessing ? 'Memproses…' : `Konfirmasi ${formatRupiah(derived.total)}`}
          </Button>
        </div>
        <p className="text-xs text-ink-500 text-center">Order akan terkirim otomatis</p>
      </div>

      {confirmLeave && (
        <Sheet open variant="center" z={60} maxWidth="max-w-sm" panelClassName="p-5" onClose={() => setConfirmLeave(false)}>
          <h3 className="text-base font-black text-ink-900 mb-2">Hapus pembayaran yang sudah dimasukkan?</h3>
          <p className="text-xs text-ink-500 mb-4">Pastikan transaksi di mesin EDC/QRIS dibatalkan.</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setConfirmLeave(false)}>Lanjut bayar</Button>
            <Button
              variant="danger"
              className="flex-1"
              onClick={() => {
                setConfirmLeave(false)
                onClose()
              }}
            >
              Hapus
            </Button>
          </div>
        </Sheet>
      )}

      {/* SP-CRM-9c: overstock confirm — warn + override, above the checkout sheet */}
      {showOverstockConfirm && (
        <Sheet open variant="center" z={60} maxWidth="max-w-sm" panelClassName="p-5" onClose={() => setShowOverstockConfirm(false)}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-2xl text-warn"><IconWarning size={24} /></span>
            <h3 className="text-base font-black text-ink-900">Stok Tidak Mencukupi</h3>
          </div>
          <p className="text-xs text-ink-500 mb-3">Penjualan ini melebihi stok. Stok akan minus:</p>
          <ul className="space-y-1 mb-4 max-h-40 overflow-y-auto">
            {overstock.map((line) => {
              const p = stockProducts.find((x) => x.id === line.productId)
              const avail = stockFor(stockProducts, line.productId, line.variantSize)
              return (
                <li key={`${line.productId}-${line.variantSize}`} className="text-xs text-ink-700 flex justify-between gap-2">
                  <span className="font-semibold">
                    {p?.name ?? line.productId}
                    {line.variantSize ? ` · ${line.variantSize}` : ''}
                  </span>
                  <span className="text-danger font-bold shrink-0">
                    diminta {line.quantity} · stok {avail ?? 0}
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setShowOverstockConfirm(false)}>
              Batal
            </Button>
            <Button variant="danger"
              className="flex-1"
              onClick={() => {
                setShowOverstockConfirm(false)
                onConfirm()
              }}
            >
              Lanjutkan
            </Button>
          </div>
        </Sheet>
      )}
    </Sheet>
  )
})
