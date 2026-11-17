import { describe, it, expect } from 'vitest'
import { fileToRaster, fitSize, urlToRaster, UPLOAD_REFUSED, URL_FAILED } from './imageToRaster'

const fileOf = (type: string, bytes: number): File => new File([new Uint8Array(bytes)], 'logo', { type })

describe('fitSize', () => {
  it('a 1000x1000 image becomes 240x240', () => {
    expect(fitSize(1000, 1000)).toEqual({ w: 240, h: 240, paddedW: 240 })
  })

  it('a 390-wide image fits 384 and pads to a multiple of 8', () => {
    const { w, h, paddedW } = fitSize(390, 100)
    expect(w).toBeLessThanOrEqual(384)
    expect(paddedW % 8).toBe(0)
    expect(paddedW).toBeLessThanOrEqual(384)
    expect(paddedW).toBeGreaterThanOrEqual(w)
    expect(h).toBeGreaterThanOrEqual(1)
  })

  it('a small image keeps its size and is not stretched', () => {
    expect(fitSize(100, 50)).toEqual({ w: 100, h: 50, paddedW: 104 })
  })

  it('keeps the aspect ratio when the width is the limit', () => {
    expect(fitSize(768, 192)).toEqual({ w: 384, h: 96, paddedW: 384 })
  })

  it('never returns an empty side for a very thin image', () => {
    const { w, h } = fitSize(2000, 1)
    expect(w).toBeLessThanOrEqual(384)
    expect(h).toBe(1)
  })
})

describe('fileToRaster', () => {
  it('refuses a 3 MB png', async () => {
    await expect(fileToRaster(fileOf('image/png', 3 * 1024 * 1024))).rejects.toThrow(UPLOAD_REFUSED)
  })

  it('refuses a gif', async () => {
    await expect(fileToRaster(fileOf('image/gif', 1000))).rejects.toThrow(UPLOAD_REFUSED)
  })

  it('says exactly what the plan says', () => {
    expect(UPLOAD_REFUSED).toBe('Gambar maks. 2 MB (PNG, JPG, WebP)')
    expect(URL_FAILED).toBe('Logo tidak bisa diambil; unggah file gambarnya.')
  })
})

describe('urlToRaster', () => {
  it('any failure becomes the upload-instead message', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new TypeError('CORS'))) as typeof fetch
    try {
      await expect(urlToRaster('https://res.example.com/logo.png')).rejects.toThrow(URL_FAILED)
    } finally {
      globalThis.fetch = real
    }
  })
})
