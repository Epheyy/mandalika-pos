// High-level print orchestration (plan §6: wire `receipt.autoPrint`/`copies`).
// Builds the ESC/POS buffer once and streams it `copies` times over whatever
// transport is wired; the no-hardware path stays the HTML preview fallback.

import { Capacitor } from '@capacitor/core'
import type { components } from '@mandalika/api'
import { buildReceipt, buildRecap, type ReceiptData, type RecapData } from './escpos'
import { CapacitorBleTransport } from './ble'
import { NoopTransport, type PrinterTransport } from './transport'

type ReceiptSettings = components['schemas']['ReceiptSettings']

/** BLE on a native build; inert Noop in the browser/dev shell. */
export function createTransport(): PrinterTransport {
  return Capacitor.isNativePlatform()
    ? new CapacitorBleTransport()
    : new NoopTransport()
}

export interface PrintJob {
  transport: PrinterTransport
  /** Persisted paired-printer id (from secure KV); null = not configured. */
  deviceId: string | null
  data: ReceiptData
  settings: ReceiptSettings
}

/**
 * Connect if needed and print. `copies` (default 1, clamped 1–5) comes from
 * `app_settings.receipt`. Throws on any failure so the caller can surface a
 * "reprint" affordance — the order itself is already recorded/queued.
 */
export async function printReceipt(job: PrintJob): Promise<void> {
  if (!job.deviceId) throw new Error('Printer belum dipilih')
  const copies = Math.min(5, Math.max(1, job.settings.copies ?? 1))
  const payload = buildReceipt(job.data, job.settings)

  await job.transport.connect(job.deviceId)
  try {
    for (let i = 0; i < copies; i++) {
      await job.transport.write(payload)
    }
  } finally {
    await job.transport.disconnect().catch(() => {})
  }
}

export interface RecapJob {
  transport: PrinterTransport
  deviceId: string | null
  data: RecapData
  settings: ReceiptSettings
}

/** Connect if needed and print a single shift-recap slip. Throws on failure. */
export async function printRecap(job: RecapJob): Promise<void> {
  if (!job.deviceId) throw new Error('Printer belum dipilih')
  const payload = buildRecap(job.data, job.settings)
  await job.transport.connect(job.deviceId)
  try {
    await job.transport.write(payload)
  } finally {
    await job.transport.disconnect().catch(() => {})
  }
}
