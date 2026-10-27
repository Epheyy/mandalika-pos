import { Money } from '../components/ui/Money'
import type { TotalRow } from './receiptRows'

const TONE: Record<TotalRow['kind'], string> = {
  subtotal: 'text-ink-700',
  promo: 'text-promo',
  surcharge: 'text-ink-700',
  points: 'text-reward',
  tax: 'text-ink-700',
  rounding: 'text-ink-700',
  total: 'font-bold text-ink-900 text-base pt-2 border-t border-paper-2',
}

/** The totals block shared by the checkout panel and the receipt preview (rows come from receiptRows.ts). */
export function ReceiptTotals({ rows }: { rows: TotalRow[] }) {
  return (
    <>
      {rows.map((r) => (
        <div key={r.key} data-testid={`total-${r.kind}`} className={`flex justify-between gap-3 ${TONE[r.kind]}`}>
          <span className="min-w-0 break-words">{r.label}</span>
          <span className="flex-shrink-0">
            {r.kind === 'rounding' && r.amount > 0 && '+'}
            <Money amount={r.amount} signed />
          </span>
        </div>
      ))}
    </>
  )
}
