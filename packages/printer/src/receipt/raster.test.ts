import { describe, it, expect } from 'vitest'
import { decodeRaster, ditherToRaster } from './raster'

describe('ditherToRaster', () => {
  it('of a 16x2 half-black image packs 0xFF00 rows', () => {
    const w = 16, h = 2
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x < 8 ? 0 : 255
        rgba.set([v, v, v, 255], (y * w + x) * 4)
      }
    }
    const r = ditherToRaster(rgba, w, h)
    expect(r.width).toBe(16)
    expect(r.height).toBe(2)
    expect(Array.from(decodeRaster(r)!)).toEqual([0xff, 0x00, 0xff, 0x00])
  })

  it('composites transparent pixels over white', () => {
    const rgba = new Uint8ClampedArray(8 * 4) // all transparent black
    expect(Array.from(decodeRaster(ditherToRaster(rgba, 8, 1))!)).toEqual([0x00])
  })

  it('refuses a width that is not a multiple of 8', () => {
    expect(() => ditherToRaster(new Uint8ClampedArray(7 * 4), 7, 1)).toThrow()
  })

  it('renders mid grey as a mix, not a flat colour', () => {
    const w = 8, h = 8
    const rgba = new Uint8ClampedArray(w * h * 4).fill(128)
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
    const bits = Array.from(decodeRaster(ditherToRaster(rgba, w, h))!).reduce((n, b) => n + b.toString(2).replace(/0/g, '').length, 0)
    expect(bits).toBeGreaterThan(16)
    expect(bits).toBeLessThan(48)
  })
})

describe('decodeRaster', () => {
  it('rejects a short data string, bad base64 and bad geometry without throwing', () => {
    expect(decodeRaster({ width: 16, height: 2, data: btoa('abc') })).toBeNull()
    expect(decodeRaster({ width: 16, height: 2, data: '!!!!' })).toBeNull()
    expect(decodeRaster({ width: 392, height: 1, data: btoa('x'.repeat(49)) })).toBeNull()
    expect(decodeRaster({ width: 8, height: 241, data: btoa('x'.repeat(241)) })).toBeNull()
    expect(decodeRaster(null)).toBeNull()
    expect(decodeRaster({ width: 8, height: 1 })).toBeNull()
  })
})
