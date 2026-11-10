// Routes each connect to Bluetooth Classic (SPP) or BLE depending on how the
// OS has the stored printer bonded, so a printer chosen before the classic
// path existed keeps working without re-pairing.

import type { ClassicBondedDevice } from './classicTypes'
import { chooseLink, findBonded } from './linkChoice'
import type { PrinterDevice, PrinterKind, PrinterTransport } from './transport'

export class AutoBluetoothTransport implements PrinterTransport {
  readonly kind: PrinterKind = 'bluetooth-auto'
  private active: PrinterTransport | null = null

  constructor(
    private readonly ble: PrinterTransport,
    private readonly spp: PrinterTransport,
    private readonly lookupBonded: () => Promise<ClassicBondedDevice[]>,
  ) {}

  isAvailable(): Promise<boolean> {
    return this.ble.isAvailable()
  }

  pickDevice(): Promise<PrinterDevice | null> {
    return this.ble.pickDevice()
  }

  async listBonded(): Promise<PrinterDevice[]> {
    return this.ble.listBonded ? this.ble.listBonded() : []
  }

  async connect(deviceId: string): Promise<void> {
    this.active = null
    let list: ClassicBondedDevice[] = []
    try {
      list = await this.lookupBonded()
    } catch {
      list = []
    }
    const delegate = chooseLink(findBonded(list, deviceId)) === 'spp' ? this.spp : this.ble
    await delegate.connect(deviceId)
    this.active = delegate
  }

  async write(payload: Uint8Array): Promise<void> {
    if (!this.active) throw new Error('Printer belum tersambung')
    await this.active.write(payload)
  }

  async disconnect(): Promise<void> {
    const delegate = this.active
    this.active = null
    if (delegate) await delegate.disconnect()
  }
}
