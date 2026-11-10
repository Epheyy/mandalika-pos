// Bluetooth Classic (serial port profile) transport for printers such as the
// Rongta RPP02N that never answer BLE GATT discovery. Printers are paired in
// Android Settings, so there is no picker here.

import { ClassicPrinter } from './classicPlugin'
import { drainDelayMs, toBase64 } from './linkChoice'
import type { PrinterDevice, PrinterKind, PrinterTransport } from './transport'

const CONNECT_TIMEOUT_MS = 10000

export class ClassicSppTransport implements PrinterTransport {
  readonly kind: PrinterKind = 'android-spp'
  private bytesWritten = 0

  async isAvailable(): Promise<boolean> {
    try {
      await ClassicPrinter.listBonded()
      return true
    } catch {
      return false
    }
  }

  async pickDevice(): Promise<PrinterDevice | null> {
    return null
  }

  async listBonded(): Promise<PrinterDevice[]> {
    const { devices } = await ClassicPrinter.listBonded()
    return devices.map((d) => ({ deviceId: d.address, name: d.name ?? 'Perangkat' }))
  }

  async connect(deviceId: string): Promise<void> {
    this.bytesWritten = 0
    await ClassicPrinter.connect({ address: deviceId, timeoutMs: CONNECT_TIMEOUT_MS })
  }

  async write(payload: Uint8Array): Promise<void> {
    await ClassicPrinter.write({ data: toBase64(payload) })
    this.bytesWritten += payload.length
  }

  async disconnect(): Promise<void> {
    const drainMs = drainDelayMs(this.bytesWritten)
    this.bytesWritten = 0
    await ClassicPrinter.disconnect({ drainMs })
  }
}
