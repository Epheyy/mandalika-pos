// Pure helpers for choosing the Bluetooth link and talking to the classic plugin.

import type { ClassicBondedDevice } from './classicTypes'

/** Serial-port printers go over SPP; everything else keeps the BLE path. */
export function chooseLink(dev: ClassicBondedDevice | undefined): 'spp' | 'ble' {
  return dev?.hasSpp || dev?.type === 'classic' ? 'spp' : 'ble'
}

/** Case-insensitive MAC lookup: the stored id comes from the BLE plugin. */
export function findBonded(
  devices: ClassicBondedDevice[],
  deviceId: string,
): ClassicBondedDevice | undefined {
  const want = deviceId.toLowerCase()
  return devices.find((d) => d.address.toLowerCase() === want)
}

export const DRAIN_BASE_MS = 300
/** Measured on the RPP02N over SPP (Task 4.5, 2026-11-23): `write()` returns at once (about 6 ms for 6 KB) because the
 *  bytes only reach the Android socket buffer; the printer then consumes them at about 2.6 to 3.9 bytes/ms for logo
 *  slips. 3 copies of a 6.4 KB logo slip (19 KB) lost the third copy with a 5.0 s wait and printed in full with 7.5 s;
 *  5 copies of a 12.5 KB slip lost four copies with a 3.0 s wait. Text-only slips are not the limit: 12 copies of a
 *  0.6 KB slip (7.2 KB) printed in full with 3.2 s. 2 bytes/ms keeps a margin of 1.3x to 1.9x under that range. */
export const DRAIN_BYTES_PER_MS = 2
/** Covers 5 copies of the largest receipt (5 x MAX_RECEIPT_PAYLOAD_BYTES = 155 KB, about 78 s) and a 120-line sale
 *  (about 41 KB per copy). The drain also holds the print queue: the next print waits for it. */
export const DRAIN_MAX_MS = 80_000

/** The largest receipt copy the TEMPLATE limits allow for a 60-line sale (a worst-case template at 58mm or 80mm,
 *  rounded up to the next 1,000 bytes; pinned by worstCase.test.ts). Cart lines are not capped, so a 120-line sale
 *  is bigger (about 41 KB measured). */
export const MAX_RECEIPT_PAYLOAD_BYTES = 31_000

/** How long to keep the socket open after the last write so the printer's
 *  buffer empties before we close (the OS may drop unsent bytes on close). */
export function drainDelayMs(bytesWritten: number): number {
  if (bytesWritten <= 0) return 0
  return Math.min(DRAIN_MAX_MS, DRAIN_BASE_MS + Math.ceil(bytesWritten / DRAIN_BYTES_PER_MS))
}

const B64_SLICE = 8192

export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += B64_SLICE) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_SLICE))
  }
  return btoa(bin)
}
