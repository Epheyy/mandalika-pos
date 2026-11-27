import { describe, expect, it } from 'vitest'
import { DEFAULT_WA_TEMPLATE, WA_PLACEHOLDERS } from '@mandalika/types'
import { WA_PLACEHOLDER_HINTS, canSaveTemplate, insertAtCursor, templateLength } from './waTemplateEdit'

describe('waTemplateEdit', () => {
  it('inserts at the caret and over a selection', () => {
    expect(insertAtCursor('Halo !', 5, 5, '{sales}')).toEqual({ text: 'Halo {sales}!', caret: 12 })
    expect(insertAtCursor('Halo XX!', 5, 7, '{outlet}')).toEqual({ text: 'Halo {outlet}!', caret: 13 })
    expect(insertAtCursor('ab', 99, 99, 'c').text).toBe('abc')
  })
  it('counts characters, not UTF-16 units', () => {
    expect(templateLength('a😀')).toBe(2)
  })
  it('saves only a valid, changed template', () => {
    expect(canSaveTemplate(DEFAULT_WA_TEMPLATE, DEFAULT_WA_TEMPLATE)).toBe(false)
    expect(canSaveTemplate('Halo', DEFAULT_WA_TEMPLATE)).toBe(false)
    expect(canSaveTemplate('Halo {foo} {tautan}', DEFAULT_WA_TEMPLATE)).toBe(false)
    expect(canSaveTemplate('Halo {tautan}', DEFAULT_WA_TEMPLATE)).toBe(true)
  })
  it('has a hint for every shared placeholder', () => {
    expect(WA_PLACEHOLDER_HINTS.map((h) => h.token)).toEqual([...WA_PLACEHOLDERS])
  })
})
