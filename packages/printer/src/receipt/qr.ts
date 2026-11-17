// QR code support for the receipt. The printer draws the code itself (`GS ( k`, model 2, error level M);
// this file only decides whether a URL may be sent and at what module size.

export const QR_URL_MAX = 300

/** Dots per module: bigger for short URLs (easier to scan), smaller so a 300-character URL still fits 58mm. */
export function qrModuleSize(len: number): number {
  return len <= 50 ? 6 : len <= 120 ? 5 : 4
}

/** True when `url` may be printed as a QR: http(s), printable ASCII, 1-300 characters. */
export function isPrintableQrUrl(url: unknown): url is string {
  return typeof url === 'string'
    && url.length > 0
    && url.length <= QR_URL_MAX
    && /^https?:\/\/[\x21-\x7e]+$/.test(url)
}

/** The five `GS ( k` commands, as exact bytes. */
export function qrBytes(data: string, moduleSize: number): number[] {
  const GS = 0x1d
  const k = [GS, 0x28, 0x6b]
  const out: number[] = []
  out.push(...k, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00) // model 2
  out.push(...k, 0x03, 0x00, 0x31, 0x43, moduleSize) // module size
  out.push(...k, 0x03, 0x00, 0x31, 0x45, 0x31) // error correction M
  const n = data.length + 3
  out.push(...k, n & 0xff, n >> 8, 0x31, 0x50, 0x30) // store data
  for (let i = 0; i < data.length; i++) out.push(data.charCodeAt(i) & 0xff)
  out.push(...k, 0x03, 0x00, 0x31, 0x51, 0x30) // print
  return out
}
