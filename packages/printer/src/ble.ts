// Native BLE ESC/POS transport via @capacitor-community/bluetooth-le —
// works on both iOS and Android (plan §6, removes the Web-Bluetooth/iOS
// limitation). The I-Ware C5813 is a generic serial-profile printer with no
// published GATT UUIDs, so we auto-discover the first writable characteristic
// and prefer well-known vendor UUIDs as a hint.

import { BleClient } from '@capacitor-community/bluetooth-le'
import type { PrinterDevice, PrinterTransport, PrinterKind } from './transport'

// Service UUIDs seen on common cheap 58 mm ESC/POS BLE printers. Listed as
// optionalServices so iOS will expose the GATT table after connect; used only
// as a discovery hint, never required.
const KNOWN_SERVICES = [
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip ISSC (frequent on these)
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
]

const CHUNK = 180 // safe payload for negotiated BLE MTU
const CHUNK_DELAY_MS = 24 // let the printer drain its small buffer

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface WriteTarget {
  service: string
  characteristic: string
  withoutResponse: boolean
}

export class CapacitorBleTransport implements PrinterTransport {
  readonly kind: PrinterKind = 'capacitor-ble'
  private deviceId: string | null = null
  private target: WriteTarget | null = null

  async isAvailable(): Promise<boolean> {
    try {
      await BleClient.initialize({ androidNeverForLocation: true })
      return await BleClient.isEnabled()
    } catch {
      return false
    }
  }

  async pickDevice(): Promise<PrinterDevice | null> {
    await BleClient.initialize({ androidNeverForLocation: true })
    try {
      const d = await BleClient.requestDevice({ optionalServices: KNOWN_SERVICES })
      return { deviceId: d.deviceId, name: d.name ?? 'Printer' }
    } catch {
      return null // user cancelled the picker
    }
  }

  async listBonded(): Promise<PrinterDevice[]> {
    try {
      await BleClient.initialize({ androidNeverForLocation: true })
      const devs = await BleClient.getBondedDevices()
      return devs.map((d) => ({
        deviceId: d.deviceId,
        name: d.name ?? 'Perangkat',
      }))
    } catch {
      // iOS has no bonded-device concept / permission denied — caller
      // falls back to the interactive scan.
      return []
    }
  }

  async connect(deviceId: string): Promise<void> {
    await BleClient.initialize({ androidNeverForLocation: true })
    await BleClient.connect(deviceId, () => {
      // Dropped link — force a fresh discovery on the next print.
      if (this.deviceId === deviceId) {
        this.deviceId = null
        this.target = null
      }
    })
    this.deviceId = deviceId
    this.target = await this.discoverWritable(deviceId)
    if (!this.target) {
      await BleClient.disconnect(deviceId).catch(() => {})
      this.deviceId = null
      throw new Error('Printer tidak punya jalur tulis ESC/POS')
    }
  }

  private async discoverWritable(deviceId: string): Promise<WriteTarget | null> {
    const services = await BleClient.getServices(deviceId)
    let fallback: WriteTarget | null = null
    for (const svc of services) {
      for (const ch of svc.characteristics) {
        const woResp = ch.properties.writeWithoutResponse
        const wResp = ch.properties.write
        if (!woResp && !wResp) continue
        const t: WriteTarget = {
          service: svc.uuid,
          characteristic: ch.uuid,
          withoutResponse: woResp,
        }
        if (KNOWN_SERVICES.includes(svc.uuid.toLowerCase())) return t
        fallback ??= t
      }
    }
    return fallback
  }

  async write(payload: Uint8Array): Promise<void> {
    if (!this.deviceId || !this.target) {
      throw new Error('Printer belum tersambung')
    }
    const { service, characteristic, withoutResponse } = this.target
    for (let i = 0; i < payload.length; i += CHUNK) {
      const slice = payload.subarray(i, i + CHUNK)
      const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength)
      if (withoutResponse) {
        await BleClient.writeWithoutResponse(this.deviceId, service, characteristic, view)
      } else {
        await BleClient.write(this.deviceId, service, characteristic, view)
      }
      if (i + CHUNK < payload.length) await sleep(CHUNK_DELAY_MS)
    }
  }

  async disconnect(): Promise<void> {
    if (this.deviceId) {
      await BleClient.disconnect(this.deviceId).catch(() => {})
    }
    this.deviceId = null
    this.target = null
  }
}
