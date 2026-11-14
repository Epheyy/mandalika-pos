import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VoidAction } from './VoidAction'
import { VOID_BLOCKED_BACKOFFICE, VOID_BLOCKED_REFUNDED } from './voidRules'

const render = (availability: Parameters<typeof VoidAction>[0]['availability']) =>
  renderToStaticMarkup(createElement(VoidAction, { availability, onVoid: vi.fn(), onCreateReplacement: vi.fn() }))

describe('VoidAction', () => {
  it('VoidAction renders Buat pengganti for create_replacement availability', () => {
    const out = render({ kind: 'create_replacement' })
    expect(out).toContain('Buat pengganti')
    expect(out).not.toContain('>Batalkan<')
  })

  it('renders Batalkan for a voidable sale, the blocked label as text, and nothing when hidden', () => {
    expect(render({ kind: 'void' })).toContain('>Batalkan<')
    expect(render({ kind: 'blocked', label: VOID_BLOCKED_BACKOFFICE })).toContain('Batalkan lewat Backoffice')
    expect(render({ kind: 'blocked', label: VOID_BLOCKED_REFUNDED })).toContain('Sudah direfund')
    expect(render({ kind: 'blocked', label: VOID_BLOCKED_BACKOFFICE })).not.toContain('<button')
    expect(render({ kind: 'hidden' })).toBe('')
  })
})
