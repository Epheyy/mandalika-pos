import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToastProvider, ToastViewport, useToast } from './Toast'

const toast = (tone: 'info' | 'ok' | 'warn' | 'danger', message = 'Pesan') => ({ id: 1, tone, message })
const view = (t: ReturnType<typeof toast> | null) => renderToStaticMarkup(createElement(ToastViewport, { toast: t }))

describe('ToastViewport', () => {
  it('keeps both live regions mounted (empty) with no toast, anchored above sheets (z-80)', () => {
    const html = view(null)
    expect(html).toContain('z-[80]')
    expect(html).toContain('<div role="status" aria-live="polite"></div>')
    expect(html).toContain('<div role="alert" aria-live="assertive"></div>')
  })

  it('shows the message as white text on a solid ink-900 surface, with a tone dot', () => {
    const html = view(toast('info', 'Ditambahkan · Parfum'))
    expect(html).toContain('Ditambahkan · Parfum')
    expect(html).toContain('bg-ink-900 ')
    expect(html).toContain('text-white')
    expect(html).not.toContain('text-ink-900')
    expect(html).toContain('bg-[#8ab4f8]')
    expect(html).not.toMatch(/backdrop-blur|bg-white\//)
  })

  it.each([
    ['info', 'status'],
    ['ok', 'status'],
    ['warn', 'alert'],
    ['danger', 'alert'],
  ] as const)('puts a %s toast inside the %s region', (tone, role) => {
    const html = view(toast(tone, 'Pesan'))
    const region = new RegExp(`<div role="${role}"[^>]*>(.*?)</div></div>`)
    expect(html.match(region)?.[0]).toContain('Pesan')
    expect(html.match(/Pesan/g)).toHaveLength(1)
  })
})

describe('ToastProvider / useToast', () => {
  it('renders its children and the viewport', () => {
    const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement('p', null, 'anak')))
    expect(html).toContain('anak')
    expect(html).toContain('z-[80]')
  })

  it('exposes showToast and dismissToast to descendants', () => {
    let api: ReturnType<typeof useToast> | undefined
    const Probe = () => {
      api = useToast()
      return null
    }
    renderToStaticMarkup(createElement(ToastProvider, null, createElement(Probe)))
    expect(typeof api?.showToast).toBe('function')
    expect(typeof api?.dismissToast).toBe('function')
  })

  it('throws a clear error outside the provider', () => {
    const Probe = () => {
      useToast()
      return null
    }
    expect(() => renderToStaticMarkup(createElement(Probe))).toThrow('useToast must be used inside <ToastProvider>')
  })
})
