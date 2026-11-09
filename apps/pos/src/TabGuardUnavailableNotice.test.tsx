import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TabGuardUnavailableNotice, TAB_GUARD_UNAVAILABLE_TEXT } from './TabGuardUnavailableNotice'

describe('TabGuardUnavailableNotice', () => {
  it('renders the visible Indonesian warning as a non-blocking status', () => {
    const html = renderToStaticMarkup(<TabGuardUnavailableNotice />)
    expect(html).toContain(TAB_GUARD_UNAVAILABLE_TEXT)
    expect(html).toContain('role="status"')
    expect(html).toContain('pointer-events:none')
  })
})
