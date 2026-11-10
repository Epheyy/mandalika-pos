// JS bridge to the in-house ClassicPrinterPlugin.java (Bluetooth Classic RFCOMM).
// No web implementation: the plugin is Android-only, like OutboxJournal.

import { registerPlugin } from '@capacitor/core'
import type { ClassicBondedDevice } from './classicTypes'

export interface ClassicPrinterPlugin {
  listBonded(): Promise<{ devices: ClassicBondedDevice[] }>
  connect(o: { address: string; timeoutMs: number }): Promise<void>
  /** `data` is base64 of the raw ESC/POS bytes. */
  write(o: { data: string }): Promise<void>
  /** Waits `drainMs` so the printer empties its buffer, then closes. */
  disconnect(o: { drainMs: number }): Promise<void>
}

export const ClassicPrinter = registerPlugin<ClassicPrinterPlugin>('ClassicPrinter')
