import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from './StatusBadge'

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(StatusBadge, { label: 'Lunas', tone: 'ok', ...props }))

describe('StatusBadge', () => {
  it('renders the label with the tone colours', () => {
    const html = render({})
    expect(html).toContain('Lunas')
    expect(html).toContain('bg-ok-bg text-ok')
  })

  it('uses paper-1 and ink-700 for the neutral tone', () => {
    expect(render({ tone: 'neutral' })).toContain('bg-paper-1 text-ink-700')
  })

  it('switches padding between sm and md sizes', () => {
    expect(render({})).toContain('text-xs')
    expect(render({ size: 'md' })).toContain('text-sm')
  })

  it('renders a dot only when requested', () => {
    expect(render({})).not.toContain('rounded-full bg-current')
    expect(render({ dot: true })).toContain('rounded-full bg-current')
  })
})
