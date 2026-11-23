// QR code support for the receipt. The printer draws the code itself (`GS ( k`, model 2, error level M);
// this file only decides whether a URL may be sent and at what module size.

export const QR_URL_MAX = 300

/** The RPP02N (Task 4.5, 2026-11-23) answers `QR CREAT ERR` and prints no code for an address of about 120 characters or
 *  more at any module size (120 failed at sizes 3 and 4, 300 at sizes 2 to 4) and for a 38-character one at size 6 with
 *  level M. Printed AND scanned on it: 38 characters at size 5, 80 characters at size 4. So the printer draws a QR only
 *  up to 80 characters, at size 4 (about 164 dots for 80 characters, inside what the printer takes); a longer address
 *  prints as wrapped text, like with graphics off. */
export const QR_NATIVE_URL_MAX = 80
export const QR_NATIVE_MODULE_SIZE = 4

/** Dots per module for a QR the printer can draw. */
export function qrModuleSize(_len?: number): number {
  return QR_NATIVE_MODULE_SIZE
}

/** True when `url` may be printed as a QR: http(s), printable ASCII, 1-300 characters. */
export function isPrintableQrUrl(url: unknown): url is string {
  return typeof url === 'string'
    && url.length > 0
    && url.length <= QR_URL_MAX
    && /^https?:\/\/[\x21-\x7e]+$/.test(url)
}

/** True when the printer may draw `url` as a QR: printable and at most 80 characters (see QR_NATIVE_URL_MAX). */
export function isNativeQrUrl(url: unknown): url is string {
  return isPrintableQrUrl(url) && url.length <= QR_NATIVE_URL_MAX
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
