import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SuratJalanDoc } from './SuratJalanDoc'
import { IngredientSuratJalanDoc } from '../../ingredients/docs/IngredientSuratJalanDoc'
import type { components } from '@mandalika/api'

type Transfer = components['schemas']['Transfer']
type IngredientTransfer = components['schemas']['IngredientTransfer']
const base = { id: 'owned', transferNo: 'TR-OWNED', suratJalanNo: 'SJ-OWNED', status: 'completed', source: { kind: 'warehouse', id: 'source', name: 'Owned Source' }, dest: { kind: 'warehouse', id: 'dest', name: 'Owned Dest' }, items: [], createdAt: '2026-09-25T01:00:00Z' }
describe('approved nullable letterhead wire migration', () => {
  for (const state of ['absent', 'null', 'object'] as const) {
    it(`renders both real document/export components with ${state}`, () => {
      const value = state === 'object' ? { locationName: 'Owned Letterhead', brandName: 'Mändalika 香', addressLines: ['Owned Street'], phone: null, npwp: null, logoUrl: null } : null
      const wire = JSON.stringify(state === 'absent' ? base : { ...base, senderLetterhead: value, receiverLetterhead: value })
      const decoded: Transfer = JSON.parse(wire)
      const ingredient: IngredientTransfer = JSON.parse(wire)
      for (const html of [renderToStaticMarkup(<SuratJalanDoc transfer={decoded} />), renderToStaticMarkup(<IngredientSuratJalanDoc transfer={ingredient} />)]) {
        expect(html).toContain('SJ-OWNED')
        expect(html).toContain('Owned Source')
        expect(html).not.toContain('undefined')
        if (state === 'object') { expect(html).toContain('Mändalika 香'); expect(html).toContain('Owned Street') }
        else { expect(html).not.toContain('Owned Street') }
      }
      expect(JSON.stringify(decoded)).toBe(wire)
    })
  }
})
