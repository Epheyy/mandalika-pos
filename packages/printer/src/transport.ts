// Swappable printer transport (plan §6: `PrinterTransport` interface,
// `capacitor-ble | none`). Keeps ESC/POS output independent of the link so
// the no-hardware fallback (HTML preview) degrades cleanly.

export type PrinterKind = 'capacitor-ble' | 'none'

export interface PrinterDevice {
  deviceId: string
  name: string
}

export interface PrinterTransport {
  readonly kind: PrinterKind
  /** True only on a native build with BLE permission/hardware available. */
  isAvailable(): Promise<boolean>
  /** Interactive scan/picker; resolves with the chosen device or null. */
  pickDevice(): Promise<PrinterDevice | null>
  /** OS-bonded (already paired) devices. Optional: not all transports
   *  support it (web/none). Preferred over a blind scan in noisy venues. */
  listBonded?(): Promise<PrinterDevice[]>
  connect(deviceId: string): Promise<void>
  /** Stream raw ESC/POS bytes (chunked internally for BLE MTU limits). */
  write(payload: Uint8Array): Promise<void>
  disconnect(): Promise<void>
}

/** Used in the browser/dev or when no printer is configured. */
export class NoopTransport implements PrinterTransport {
  readonly kind: PrinterKind = 'none'
  async isAvailable(): Promise<boolean> {
    return false
  }
  async pickDevice(): Promise<PrinterDevice | null> {
    return null
  }
  async connect(): Promise<void> {
    throw new Error('Tidak ada printer (mode pratinjau)')
  }
  async write(): Promise<void> {
    throw new Error('Tidak ada printer (mode pratinjau)')
  }
  async disconnect(): Promise<void> {
    /* nothing to release */
  }
}
