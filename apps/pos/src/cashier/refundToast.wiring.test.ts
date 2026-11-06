import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// P4: the refund confirmation toast is raised only once the refund is stored, never on a refused or failed attempt.
describe('refund success toast wiring', () => {
  const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('const handleRefundConfirm'), src.indexOf('// A08: only called after the server minted a grant'))
  it('shows the toast after the failed/busy returns and after the dialog closes', () => {
    const toast = body.indexOf('kitToast.showToast(')
    expect(toast).toBeGreaterThan(body.indexOf("outcome.status === 'failed'"))
    expect(toast).toBeGreaterThan(body.indexOf('setRefundOrder(null)'))
    expect(body.match(/kitToast\.showToast\(/g)).toHaveLength(1)
  })
})
