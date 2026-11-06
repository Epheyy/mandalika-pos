import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_SETTINGS } from './settingsDiff'
import { TransaksiSection } from './TransaksiSection'

const html = renderToStaticMarkup(
  <TransaksiSection s={DEFAULT_SETTINGS} setS={() => {}} newPay="" setNewPay={() => {}} changed={new Set()} />,
)

// #18: the two switch columns are named once in a header row; every row keeps its own named switches.
describe('payment-method rows', () => {
  it('has the column headers', () => {
    expect(html).toContain('>Masuk laci kas<')
    expect(html).toContain('>Aktif<')
  })

  it('keeps an accessible switch per method for both columns', () => {
    for (const m of DEFAULT_SETTINGS.paymentMethods) {
      expect(html).toContain(`aria-label="Metode ${m.label} masuk laci kas"`)
      expect(html).toContain(`aria-label="Aktifkan metode ${m.label}"`)
    }
  })
})
