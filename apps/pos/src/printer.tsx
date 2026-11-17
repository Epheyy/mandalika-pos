/**
 * Printer context (plan §6). Owns the BLE transport, the paired-printer id
 * (persisted in secure storage), and the print/reprint/test entry points.
 * Printing is local BLE — fully functional offline, independent of sync.
 */

import {
  createContext,
  useCallback,
  use,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { components } from '@mandalika/api'
import {
  createTransport,
  printReceipt,
  printRecap,
  printTandaTerima,
  printVoidSlip,
  type PrinterTransport,
  type ReceiptData,
  type ReceiptLayout,
  type RecapData,
  type TandaTerimaData,
  type VoidSlipData,
} from '@mandalika/printer'
import { getKV } from '@mandalika/sync'
import { reportErrors } from './lib/errorReporter'
import { SAMPLE_RECEIPT } from '@mandalika/printer/render'
import { deviceGraphics, devicePaperWidth } from './receiptLayout'

type ReceiptSettings = components['schemas']['ReceiptSettings']

const PRINTER_KEY = 'mandalika.pos.printerDeviceId'
const PRINTER_NAME_KEY = 'mandalika.pos.printerName'

interface PrinterState {
  /** Native build with a BLE-capable transport. */
  supported: boolean
  pairedName: string | null
  isPaired: boolean
  /** Already-bonded (OS-paired) devices — preferred over a blind scan in a
   *  noisy environment like a mall. */
  listBonded: () => Promise<{ deviceId: string; name: string }[]>
  /** Pair to a specific (bonded) device the cashier picked from the list. */
  pairTo: (deviceId: string, name: string) => void
  pair: () => Promise<boolean>
  unpair: () => void
  /** `layout` is the outlet's receipt layout (Standar when it has no template); a wider one reflows to this tablet's paper. */
  print: (data: ReceiptData, settings: ReceiptSettings, reprint?: boolean, layout?: ReceiptLayout) => Promise<void>
  printRecap: (data: RecapData, settings: ReceiptSettings) => Promise<void>
  printTandaTerima: (data: TandaTerimaData, settings: ReceiptSettings, reprint?: boolean) => Promise<void>
  /** DIBATALKAN slip; `layout` is reserved for the receipt designer (the slip does not read it yet). */
  printVoidSlip: (data: VoidSlipData, settings: ReceiptSettings, layout?: ReceiptLayout) => Promise<void>
  testPrint: (settings: ReceiptSettings, layout?: ReceiptLayout) => Promise<void>
}

/** The layout fields of a print job: the device paper clamp, and a report when a template block was skipped or the
 *  whole template fell back to the legacy receipt (the sale still prints either way). */
function receiptLayoutOptions(layout: ReceiptLayout | undefined, orderRef: string) {
  if (!layout) return {}
  return {
    layout,
    maxPaperWidth: devicePaperWidth(),
    graphics: deviceGraphics(),
    onLayoutError: (e: unknown) => {
      void reportErrors([{
        source: 'print', kind: 'receipt_template', action: `Cetak struk ${orderRef}`,
        message: e instanceof Error ? e.message : 'template struk gagal dirender',
      }])
    },
  }
}

const PrinterCtx = createContext<PrinterState | null>(null)

export function PrinterProvider({ children }: { children: ReactNode }) {
  const transportRef = useRef<PrinterTransport>(null as unknown as PrinterTransport)
  if (!transportRef.current) transportRef.current = createTransport()
  const kv = getKV()
  const [pairedId, setPairedId] = useState<string | null>(
    () => kv.get(PRINTER_KEY),
  )
  const [pairedName, setPairedName] = useState<string | null>(
    () => kv.get(PRINTER_NAME_KEY),
  )

  const supported = transportRef.current.kind !== 'none'

  const pair = useCallback(async (): Promise<boolean> => {
    const dev = await transportRef.current.pickDevice()
    if (!dev) return false
    kv.set(PRINTER_KEY, dev.deviceId)
    kv.set(PRINTER_NAME_KEY, dev.name)
    setPairedId(dev.deviceId)
    setPairedName(dev.name)
    return true
  }, [kv])

  const listBonded = useCallback(async () => {
    const t = transportRef.current
    return t.listBonded ? t.listBonded() : []
  }, [])

  const pairTo = useCallback(
    (deviceId: string, name: string) => {
      kv.set(PRINTER_KEY, deviceId)
      kv.set(PRINTER_NAME_KEY, name)
      setPairedId(deviceId)
      setPairedName(name)
    },
    [kv],
  )

  const unpair = useCallback(() => {
    kv.remove(PRINTER_KEY)
    kv.remove(PRINTER_NAME_KEY)
    setPairedId(null)
    setPairedName(null)
  }, [kv])

  const print = useCallback(
    async (data: ReceiptData, settings: ReceiptSettings, reprint?: boolean, layout?: ReceiptLayout) => {
      await printReceipt({
        transport: transportRef.current,
        deviceId: pairedId,
        data,
        settings,
        reprint,
        ...receiptLayoutOptions(layout, data.orderRef),
      })
    },
    [pairedId],
  )

  const doPrintRecap = useCallback(
    async (data: RecapData, settings: ReceiptSettings) => {
      await printRecap({
        transport: transportRef.current,
        deviceId: pairedId,
        data,
        settings,
      })
    },
    [pairedId],
  )

  const doPrintTandaTerima = useCallback(
    async (data: TandaTerimaData, settings: ReceiptSettings, reprint?: boolean) => {
      await printTandaTerima({
        transport: transportRef.current,
        deviceId: pairedId,
        data,
        settings,
        reprint,
      })
    },
    [pairedId],
  )

  const testPrint = useCallback(
    async (settings: ReceiptSettings, layout?: ReceiptLayout) => {
      // The mockup sale, so a logo, QR, points and the bundle rows all show what the template does with them.
      const sample: ReceiptData = { ...SAMPLE_RECEIPT, dateTime: new Date() }
      await printReceipt({
        transport: transportRef.current,
        deviceId: pairedId,
        data: sample,
        settings,
        ...receiptLayoutOptions(layout, sample.orderRef),
      })
    },
    [pairedId],
  )

  const doPrintVoidSlip = useCallback(
    async (data: VoidSlipData, settings: ReceiptSettings, layout?: ReceiptLayout) => {
      await printVoidSlip({
        transport: transportRef.current,
        deviceId: pairedId,
        data,
        settings,
        layout,
      })
    },
    [pairedId],
  )

  const value = useMemo<PrinterState>(
    () => ({
      supported,
      pairedName,
      isPaired: pairedId != null,
      listBonded,
      pairTo,
      pair,
      unpair,
      print,
      printRecap: doPrintRecap,
      printTandaTerima: doPrintTandaTerima,
      printVoidSlip: doPrintVoidSlip,
      testPrint,
    }),
    [supported, pairedName, pairedId, listBonded, pairTo, pair, unpair, print, doPrintRecap, doPrintTandaTerima, doPrintVoidSlip, testPrint],
  )

  return <PrinterCtx.Provider value={value}>{children}</PrinterCtx.Provider>
}

export function usePrinter(): PrinterState {
  const ctx = use(PrinterCtx)
  if (!ctx) throw new Error('usePrinter must be used within PrinterProvider')
  return ctx
}
