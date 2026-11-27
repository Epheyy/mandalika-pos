import { describe, expect, it } from 'vitest'
import vectors from './__fixtures__/wa-receipt-vectors.json'
import {
  DEFAULT_WA_TEMPLATE,
  WA_PLACEHOLDERS,
  WA_SAMPLE_VALUES,
  formatRupiahWa,
  maskPhone,
  renderWaTemplate,
  validateWaTemplate,
  waDigits,
  waUrl,
} from './waReceipt'

describe('waReceipt vectors', () => {
  it.each(vectors.render)('render: $name', (v) => {
    expect(renderWaTemplate(v.template, v.values)).toBe(v.expected)
  })
  it.each(vectors.validate)('validate: ok=$ok', (v) => {
    const msg = validateWaTemplate(v.template)
    expect(msg === null).toBe(v.ok)
    if (!v.ok) expect(typeof msg).toBe('string')
  })
  it.each(vectors.rupiah)('rupiah: $n', (v) => {
    expect(formatRupiahWa(v.n)).toBe(v.expected)
  })
  it.each(vectors.waDigits)('waDigits: "$raw"', (v) => {
    expect(waDigits(v.raw)).toBe(v.expected)
  })
  it.each(vectors.mask)('mask: $digits', (v) => {
    expect(maskPhone(v.digits)).toBe(v.expected)
  })
  it.each(vectors.waUrl)('waUrl: $digits', (v) => {
    expect(waUrl(v.digits, v.text)).toBe(v.expected)
  })
})

describe('waReceipt basics', () => {
  it('default template and sample values are valid and fully expanded', () => {
    expect(validateWaTemplate(DEFAULT_WA_TEMPLATE)).toBeNull()
    for (const p of WA_PLACEHOLDERS) expect(DEFAULT_WA_TEMPLATE).toContain(p)
    expect(renderWaTemplate(DEFAULT_WA_TEMPLATE, WA_SAMPLE_VALUES)).not.toMatch(/\{[a-z_]+\}/)
  })
  it('names the missing and the unknown placeholder in the error', () => {
    expect(validateWaTemplate('halo')).toBe('Template wajib memuat {tautan}')
    expect(validateWaTemplate('{tautan} {foo}')).toContain('{foo}')
  })
})
