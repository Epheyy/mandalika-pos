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
  type PrinterTransport,
  type ReceiptData,
  type RecapData,
  type TandaTerimaData,
} from '@mandalika/printer'
import { getKV } from '@mandalika/sync'

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
  print: (data: ReceiptData, settings: ReceiptSettings, reprint?: boolean) => Promise<void>
  printRecap: (data: RecapData, settings: ReceiptSettings) => Promise<void>
  printTandaTerima: (data: TandaTerimaData, settings: ReceiptSettings, reprint?: boolean) => Promise<void>
  testPrint: (settings: ReceiptSettings) => Promise<void>
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
    async (data: ReceiptData, settings: ReceiptSettings, reprint?: boolean) => {
      await printReceipt({
        transport: transportRef.current,
        deviceId: pairedId,
        data,
        settings,
        reprint,
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
    async (settings: ReceiptSettings) => {
      const now = new Date()
      const sample: ReceiptData = {
        orderRef: 'TEST',
        pending: false,
        dateTime: now,
        lines: [
          { name: 'Tes Cetak', qty: 1, unitPrice: 1000, amount: 1000 },
        ],
        subtotal: 1000,
        discountAmount: 0,
        taxAmount: 0,
        total: 1000,
        paymentLabel: 'Tunai',
        amountPaid: 1000,
        change: 0,
        customerName: null,
        customerPhone: null,
        cashierName: 'Kasir',
      }
      await printReceipt({
        transport: transportRef.current,
        deviceId: pairedId,
        data: sample,
        settings,
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
      testPrint,
    }),
    [supported, pairedName, pairedId, listBonded, pairTo, pair, unpair, print, doPrintRecap, doPrintTandaTerima, testPrint],
  )

  return <PrinterCtx.Provider value={value}>{children}</PrinterCtx.Provider>
}

export function usePrinter(): PrinterState {
  const ctx = use(PrinterCtx)
  if (!ctx) throw new Error('usePrinter must be used within PrinterProvider')
  return ctx
}
