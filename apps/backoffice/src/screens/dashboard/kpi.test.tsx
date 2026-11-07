import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KpiCard, formatDelta } from './components'

describe('KpiCard (BO5-01)', () => {
  it('formats the delta with one id-ID decimal and an arrow', () => {
    expect(formatDelta(14.2)).toBe('↗ 14,2%')
    expect(formatDelta(-3.04)).toBe('↘ 3,0%')
    expect(formatDelta(0)).toBe('↗ 0,0%')
    expect(formatDelta(-0.04)).toBe('↗ 0,0%') // rounds first: no red zero
  })
  it('renders label above value and the delta pill with comparison words', () => {
    const html = renderToStaticMarkup(<KpiCard label="Penjualan" value="Rp 1" deltaPct={14.2} compare="vs 30 hari lalu" />)
    expect(html.indexOf('Penjualan')).toBeLessThan(html.indexOf('Rp 1'))
    expect(html).toContain('↗ 14,2%')
    expect(html).toContain('vs 30 hari lalu')
    expect(html).toContain('naik')
  })
  it('tints a drop red and says turun', () => {
    const html = renderToStaticMarkup(<KpiCard label="x" value="1" deltaPct={-3.04} compare="vs kemarin" />)
    expect(html).toContain('bg-danger-bg')
    expect(html).toContain('turun')
  })
  it('hides the pill without a delta', () => {
    expect(renderToStaticMarkup(<KpiCard label="x" value="1" deltaPct={null} />)).not.toContain('%')
  })
})
