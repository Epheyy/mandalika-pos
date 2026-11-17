import { describe, it, expect } from 'vitest'
import { EscPosSink, PreviewSink, type Cmd } from './sink'
import { encodeLegacy } from './text'

const EXPECTED: Record<Cmd, number[]> = {
  init: [0x1b, 0x40],
  alignLeft: [0x1b, 0x61, 0],
  alignCenter: [0x1b, 0x61, 1],
  alignRight: [0x1b, 0x61, 2],
  boldOn: [0x1b, 0x45, 1],
  boldOff: [0x1b, 0x45, 0],
  largeOn: [0x1d, 0x21, 0x11],
  largeOff: [0x1d, 0x21, 0],
  feed3: [0x1b, 0x64, 3],
  cut: [0x1d, 0x56, 0x42, 0],
}

describe('sinks', () => {
  it('EscPosSink writes the legacy byte for every Cmd and maps text exactly like encodeLegacy', () => {
    for (const [cmd, bytes] of Object.entries(EXPECTED)) {
      const s = new EscPosSink()
      s.cmd(cmd as Cmd)
      expect(Array.from(s.done()), cmd).toEqual(bytes)
    }
    const s = new EscPosSink()
    s.line('Café · ☺')
    s.line()
    expect(Array.from(s.done())).toEqual([...encodeLegacy('Café · ☺'), 0x0a, 0x0a])
  })

  it('PreviewSink splits a 40-char large line into 16+16+8 at cols 32 and keeps bold/align', () => {
    const p = new PreviewSink(32)
    p.cmd('alignCenter'); p.cmd('boldOn'); p.cmd('largeOn')
    p.line('x'.repeat(40))
    p.cmd('largeOff'); p.cmd('boldOff'); p.cmd('alignLeft')
    p.line('plain')
    const lines = p.done()
    expect(lines.map((l) => (l.kind === 'text' ? l.text.length : -1))).toEqual([16, 16, 8, 5])
    expect(lines[0]).toMatchObject({ align: 'center', bold: true, large: true })
    expect(lines[3]).toMatchObject({ align: 'left', bold: false, large: false })
  })

  it('PreviewSink text equals what the bytes print (middle dot becomes -, smiley becomes ?)', () => {
    const p = new PreviewSink(32)
    p.line('a·b☺')
    expect(p.done()[0]).toMatchObject({ text: 'a-b?' })
  })

  it('PreviewSink keeps an empty line and resets on init', () => {
    const p = new PreviewSink(32)
    p.cmd('boldOn')
    p.cmd('init')
    p.line()
    expect(p.done()).toEqual([{ kind: 'text', text: '', align: 'left', bold: false, large: false }])
  })
})
