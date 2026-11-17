import { describe, it, expect } from 'vitest'
import { rasterToBmpDataUrl } from './rasterPreview'

const bytesOf = (url: string): Uint8Array => Uint8Array.from(atob(url.split(',')[1]!), (c) => c.charCodeAt(0))

describe('rasterToBmpDataUrl', () => {
  it('writes a 1-bit BMP whose rows run bottom to top', () => {
    // two rows of 8 dots: top 10000000, bottom 00000001
    const data = btoa(String.fromCharCode(0x80, 0x01))
    const url = rasterToBmpDataUrl({ width: 8, height: 2, data })!
    expect(url.startsWith('data:image/bmp;base64,')).toBe(true)
    const b = bytesOf(url)
    expect(String.fromCharCode(b[0]!, b[1]!)).toBe('BM')
    expect(b[62]).toBe(0x01) // first stored row is the bottom row
    expect(b[66]).toBe(0x80) // second stored row is the top row, each padded to 4 bytes
  })

  it('refuses a malformed raster', () => {
    expect(rasterToBmpDataUrl({ width: 8, height: 2, data: 'AA==' })).toBeNull()
    expect(rasterToBmpDataUrl({ width: 8, height: 1, data: '***' })).toBeNull()
  })
})
