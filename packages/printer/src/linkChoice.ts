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

const DRAIN_BASE_MS = 300
const DRAIN_BYTES_PER_MS = 8
const DRAIN_MAX_MS = 3000

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
