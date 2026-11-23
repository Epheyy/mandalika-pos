import { describe, it, expect } from 'vitest'
import { isNativeQrUrl, isPrintableQrUrl, qrBytes, qrModuleSize } from './qr'

describe('qr', () => {
  it('uses module size 4, the size the RPP02N printed and scanned up to 80 characters', () => {
    expect([qrModuleSize(), qrModuleSize(38), qrModuleSize(80)]).toEqual([4, 4, 4])
  })

  it('draws a native QR only up to 80 characters (the RPP02N refuses longer addresses)', () => {
    expect(isNativeQrUrl('https://' + 'a'.repeat(72))).toBe(true) // 80
    expect(isNativeQrUrl('https://' + 'a'.repeat(73))).toBe(false) // 81
    expect(isNativeQrUrl('ftp://a.id')).toBe(false)
  })

  it('accepts http(s) printable urls up to 300 chars only', () => {
    expect(isPrintableQrUrl('https://a.id/x')).toBe(true)
    expect(isPrintableQrUrl('https://' + 'a'.repeat(292))).toBe(true)
    expect(isPrintableQrUrl('https://' + 'a'.repeat(293))).toBe(false)
    expect(isPrintableQrUrl('ftp://a.id')).toBe(false)
    expect(isPrintableQrUrl('https://a b')).toBe(false)
    expect(isPrintableQrUrl('')).toBe(false)
  })

  it('emits the five GS ( k commands with pL/pH for a 300-char url', () => {
    const url = 'https://' + 'a'.repeat(292)
    const b = qrBytes(url, 4)
    const head = [0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
      0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x04,
      0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]
    expect(b.slice(0, head.length)).toEqual(head)
    const store = b.slice(head.length)
    // len + 3 = 303 = 0x012F
    expect(store.slice(0, 8)).toEqual([0x1d, 0x28, 0x6b, 0x2f, 0x01, 0x31, 0x50, 0x30])
    expect(store.slice(8, 8 + 300)).toEqual(Array.from(url, (c) => c.charCodeAt(0)))
    expect(store.slice(8 + 300)).toEqual([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30])
  })
})
