// High-level print orchestration (plan §6: wire `receipt.autoPrint`/`copies`).
// Builds the ESC/POS buffer once and streams it `copies` times over whatever
// transport is wired; the no-hardware path stays the HTML preview fallback.

import { Capacitor } from '@capacitor/core'
import type { components } from '@mandalika/api'
import { buildReceipt, buildRecap, buildTandaTerima, buildVoidSlip, type ReceiptData, type RecapData, type TandaTerimaData, type VoidSlipData } from './escpos'
import { buildReceiptV1 } from './__legacy__/buildReceiptV1'
import type { PaperWidth, ReceiptLayout } from './receipt/layout'
import { receiptBytes } from './receipt/render'
import { CapacitorBleTransport } from './ble'
import { AutoBluetoothTransport } from './autoTransport'
import { ClassicSppTransport } from './classic'
import { ClassicPrinter } from './classicPlugin'
import { printerErrorMessage } from './printerError'
import { runExclusive } from './printQueue'
import { NoopTransport, type PrinterTransport } from './transport'

type ReceiptSettings = components['schemas']['ReceiptSettings']

/** Android: BLE or Bluetooth Classic per bonded device. Other native: BLE.
 *  Browser/dev shell: inert Noop. */
export function createTransport(): PrinterTransport {
  if (Capacitor.getPlatform() === 'android') {
    return new AutoBluetoothTransport(
      new CapacitorBleTransport(),
      new ClassicSppTransport(),
      async () => (await ClassicPrinter.listBonded()).devices,
    )
  }
  return Capacitor.isNativePlatform() ? new CapacitorBleTransport() : new NoopTransport()
}

/**
 * One connect → write×copies → disconnect, serialized with every other print
 * job. Any failure is rethrown with Indonesian copy starting "Gagal".
 */
function sendJob(
  transport: PrinterTransport,
  deviceId: string | null,
  buildPayload: () => Uint8Array,
  copies: number,
): Promise<void> {
  return runExclusive(async () => {
    try {
      if (!deviceId) throw new Error('Printer belum dipilih')
      const payload = buildPayload()
      await transport.connect(deviceId)
      try {
        for (let i = 0; i < copies; i++) {
          await transport.write(payload)
        }
      } finally {
        await transport.disconnect().catch(() => {})
      }
    } catch (e) {
      throw new Error(printerErrorMessage(e))
    }
  })
}

export interface PrintJob {
  transport: PrinterTransport
  /** Persisted paired-printer id (from secure KV); null = not configured. */
  deviceId: string | null
  data: ReceiptData
  settings: ReceiptSettings
  /** Stamp a "CETAK ULANG (REPRINT)" marker on the slip. Default false. */
  reprint?: boolean
  /** The outlet's receipt template. Absent = the built-in Standar layout (today's bytes). */
  layout?: ReceiptLayout
  /** The tablet's paper width: a wider template reflows to it. Only read with `layout`. */
  maxPaperWidth?: PaperWidth
  /** The device can print raster images and QR codes (the `Cetak logo & QR` switch). Default true; off prints no logo and the QR as text. Only read with `layout`. */
  graphics?: boolean
  /** Called when a template block was skipped, or the whole template fell back to the legacy receipt. */
  onLayoutError?: (e: unknown) => void
}

/**
 * The payload of one receipt copy. With a layout it renders the template; if that throws for any reason
 * (a locked block failed, a bug) it reports and prints the frozen legacy receipt instead, never the
 * renderer again, so a template can never cost the sale its receipt.
 */
function receiptPayload(job: PrintJob): Uint8Array {
  if (!job.layout) return buildReceipt(job.data, job.settings, job.reprint)
  try {
    return receiptBytes(job.layout, job.data, {
      reprint: job.reprint,
      maxPaperWidth: job.maxPaperWidth,
      graphics: job.graphics,
      onBlockError: (_id, e) => job.onLayoutError?.(e),
    })
  } catch (e) {
    job.onLayoutError?.(e)
    return buildReceiptV1(job.data, job.settings, job.reprint)
  }
}

/**
 * Connect if needed and print. `copies` (default 1, clamped 1–5) comes from
 * `app_settings.receipt`. Throws on any failure so the caller can surface a
 * "reprint" affordance — the order itself is already recorded/queued.
 */
export async function printReceipt(job: PrintJob): Promise<void> {
  const copies = Math.min(5, Math.max(1, job.settings.copies ?? 1))
  await sendJob(
    job.transport,
    job.deviceId,
    () => receiptPayload(job),
    copies,
  )
}

export interface RecapJob {
  transport: PrinterTransport
  deviceId: string | null
  data: RecapData
  settings: ReceiptSettings
}

/** Connect if needed and print a single shift-recap slip. Throws on failure. */
export async function printRecap(job: RecapJob): Promise<void> {
  await sendJob(job.transport, job.deviceId, () => buildRecap(job.data, job.settings), 1)
}

export interface TandaTerimaJob {
  transport: PrinterTransport
  deviceId: string | null
  data: TandaTerimaData
  settings: ReceiptSettings
  /** Stamp a "CETAK ULANG (REPRINT)" marker on the slip. Default false. */
  reprint?: boolean
}

/** Connect if needed and print a single tanda terima slip. Throws on failure
 *  so the caller can surface a "cetak ulang" affordance — the receive itself
 *  is already recorded on the server.
 */
export async function printTandaTerima(job: TandaTerimaJob): Promise<void> {
  await sendJob(
    job.transport,
    job.deviceId,
    () => buildTandaTerima(job.data, job.settings, job.reprint),
    1,
  )
}

export interface VoidSlipJob {
  transport: PrinterTransport
  deviceId: string | null
  data: VoidSlipData
  settings: ReceiptSettings
  /** Reserved for the receipt designer; the slip does not read it yet. */
  layout?: ReceiptLayout
}

/** Connect if needed and print a single DIBATALKAN slip. Throws on failure. */
export async function printVoidSlip(job: VoidSlipJob): Promise<void> {
  await sendJob(job.transport, job.deviceId, () => buildVoidSlip(job.data), 1)
}
