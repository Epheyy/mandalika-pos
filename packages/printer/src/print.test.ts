import { beforeEach, describe, expect, it, vi } from 'vitest'

const cap = vi.hoisted(() => ({ platform: 'web' }))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => cap.platform,
    isNativePlatform: () => cap.platform !== 'web',
  },
  registerPlugin: () => ({}),
}))

import { buildReceipt } from './escpos'
import { buildReceiptV1 } from './__legacy__/buildReceiptV1'
import { createTransport, printReceipt, printVoidSlip } from './print'
import type { ReceiptLayout } from './receipt/layout'
import type { PrinterTransport } from './transport'
import type { PrintJob } from './print'
import { DRAIN_MAX_MS, drainDelayMs } from './linkChoice'

const settings = { copies: 1, headerText: 'TOKO', footerText: '', showTax: true } as PrintJob['settings']
const data: PrintJob['data'] = {
  orderRef: 'T1', pending: false, dateTime: new Date('2026-05-29T00:00:00Z'),
  lines: [], subtotal: 0, discountAmount: 0, taxAmount: 0, total: 0,
  paymentLabel: 'Tunai', amountPaid: 0, change: 0, customerName: null, customerPhone: null, cashierName: 'Kasir',
}

function recorder(opts: { connectFail?: Error; writeDelay?: number } = {}) {
  const calls: string[] = []
  const t: PrinterTransport = {
    kind: 'none',
    isAvailable: async () => true,
    pickDevice: async () => null,
    connect: async () => {
      calls.push('connect')
      if (opts.connectFail) throw opts.connectFail
    },
    write: async () => {
      calls.push('write')
      if (opts.writeDelay) await new Promise((r) => setTimeout(r, opts.writeDelay))
    },
    disconnect: async () => {
      calls.push('disconnect')
    },
  }
  return { t, calls }
}

beforeEach(() => {
  cap.platform = 'web'
})

describe('print jobs', () => {
  it('serializes overlapping prints', async () => {
    const { t, calls } = recorder({ writeDelay: 20 })
    const job = { transport: t, deviceId: 'AA', data, settings }
    await Promise.all([printReceipt(job), printReceipt(job)])
    expect(calls).toEqual(['connect', 'write', 'disconnect', 'connect', 'write', 'disconnect'])
  })

  it('maps a BLE timeout to Indonesian copy', async () => {
    const { t } = recorder({ connectFail: new Error('Connection timeout.') })
    await expect(printReceipt({ transport: t, deviceId: 'AA', data, settings })).rejects.toThrow(
      'Gagal mencetak: printer tidak menjawab. Pastikan printer menyala, ada kertas, dan dekat dengan tablet.',
    )
  })

  it('runs the next job after a failed one', async () => {
    const order: string[] = []
    let firstSettled = false
    let rejectFirst!: (e: Error) => void
    const first: PrinterTransport = {
      ...recorder().t,
      connect: () =>
        new Promise<void>((_, reject) => {
          order.push('first:connect')
          rejectFirst = reject
        }),
    }
    const second: PrinterTransport = {
      ...recorder().t,
      connect: async () => {
        order.push('second:connect')
      },
      write: async () => {
        order.push(`second:write firstSettled=${firstSettled}`)
      },
    }
    const p1 = printReceipt({ transport: first, deviceId: 'AA', data, settings })
    const p1Result = p1.then(
      () => 'resolved',
      (e: Error) => {
        firstSettled = true
        return e.message
      },
    )
    const p2 = printReceipt({ transport: second, deviceId: 'AA', data, settings })
    await new Promise((r) => setTimeout(r, 20))
    // The second job must not start while the first is still pending.
    expect(order).toEqual(['first:connect'])
    order.push('first:reject')
    rejectFirst(new Error('x'))
    await p2
    // The first rejection reaches its own caller; job two starts only after it was issued.
    expect(await p1Result).toMatch(/^Gagal/)
    expect(order).toEqual([
      'first:connect',
      'first:reject',
      'second:connect',
      'second:write firstSettled=true',
    ])
  })

  it('reports a missing printer in Indonesian', async () => {
    const { t } = recorder()
    await expect(printReceipt({ transport: t, deviceId: null, data, settings })).rejects.toThrow(
      'Gagal mencetak: Printer belum dipilih',
    )
  })
})

describe('createTransport', () => {
  it.each([
    ['android', 'bluetooth-auto'],
    ['ios', 'capacitor-ble'],
    ['web', 'none'],
  ])('%s -> %s', (platform, kind) => {
    cap.platform = platform
    expect(createTransport().kind).toBe(kind)
  })
})

describe('printVoidSlip', () => {
  it('printVoidSlip sends one copy through the print queue', async () => {
    const { t, calls } = recorder()
    const slipData = { orderRef: 'MND-1', total: 100000, reasonLabel: 'Salah barang', voidedBy: 'Sari', dateTime: '14/11/2026 10:00' }
    await printVoidSlip({ transport: t, deviceId: 'AA', data: slipData, settings: { ...settings, copies: 3 } })
    expect(calls).toEqual(['connect', 'write', 'disconnect'])
  })

  it('reports a missing printer in Indonesian', async () => {
    const { t } = recorder()
    const slipData = { orderRef: 'MND-1', total: 1, reasonLabel: 'x', voidedBy: 'x', dateTime: 'x' }
    await expect(printVoidSlip({ transport: t, deviceId: null, data: slipData, settings })).rejects.toThrow(/^Gagal/)
  })
})

describe('printReceipt with a layout', () => {
  const full = { ...settings, headerText: 'TOKO', footerText: 'Terima kasih' }
  const goodLayout = (): ReceiptLayout => ({
    paperWidth: 58,
    blocks: [
      { id: 't', type: 'text', enabled: true, text: 'HALO', align: 'center', bold: false, size: 'normal' },
      { id: 'i', type: 'items', enabled: true },
      { id: 'o', type: 'totals', enabled: true, showSubtotal: true, showDiscount: true, showTax: true },
      { id: 'p', type: 'payment', enabled: true },
    ],
  })
  function capture(copies = 1) {
    const writes: Uint8Array[] = []
    const calls: string[] = []
    const t: PrinterTransport = {
      kind: 'none',
      isAvailable: async () => true,
      pickDevice: async () => null,
      connect: async () => { calls.push('connect') },
      write: async (b) => { writes.push(b); calls.push('write') },
      disconnect: async () => { calls.push('disconnect') },
    }
    return { t, writes, calls, settings: { ...full, copies } }
  }
  const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

  it('prints Standar bytes (buildReceipt) when there is no layout', async () => {
    const c = capture()
    await printReceipt({ transport: c.t, deviceId: 'AA', data, settings: c.settings })
    expect(Array.from(c.writes[0]!)).toEqual(Array.from(buildReceipt(data, c.settings)))
  })

  it('renders the template and keeps copies, the queue order and the write path', async () => {
    const c = capture(3)
    await printReceipt({ transport: c.t, deviceId: 'AA', data, settings: c.settings, layout: goodLayout(), maxPaperWidth: 58 })
    expect(c.calls).toEqual(['connect', 'write', 'write', 'write', 'disconnect'])
    expect(text(c.writes[0]!)).toContain('HALO')
    expect(Array.from(c.writes[0]!)).toEqual(Array.from(c.writes[2]!))
  })

  it('prints buildReceiptV1 bytes and calls onLayoutError when the layout cannot render', async () => {
    const c = capture()
    const errors: unknown[] = []
    const broken = { ...goodLayout(), paperWidth: 70 } as unknown as ReceiptLayout
    await printReceipt({ transport: c.t, deviceId: 'AA', data, settings: c.settings, layout: broken, onLayoutError: (e) => errors.push(e) })
    expect(errors).toHaveLength(1)
    expect(Array.from(c.writes[0]!)).toEqual(Array.from(buildReceiptV1(data, c.settings, false)))
  })

  it('skips a throwing text block, reports it, and still prints items, totals and payment', async () => {
    const c = capture()
    const errors: unknown[] = []
    const layout = goodLayout()
    layout.blocks[0] = { id: 't', type: 'text', enabled: true, text: { not: 'a string' } as unknown as string, align: 'left', bold: false, size: 'normal' }
    await printReceipt({ transport: c.t, deviceId: 'AA', data, settings: c.settings, layout, onLayoutError: (e) => errors.push(e) })
    expect(errors).toHaveLength(1)
    const out = text(c.writes[0]!)
    expect(out).toContain('TOTAL')
    expect(out).not.toContain('not a string')
  })

  it('still reports a missing printer in Indonesian', async () => {
    const c = capture()
    await expect(printReceipt({ transport: c.t, deviceId: null, data, settings: c.settings, layout: goodLayout() })).rejects.toThrow(/^Gagal/)
  })
})

describe('graphics switch and the queue after a drain', () => {
  const qrLayout: ReceiptLayout = {
    paperWidth: 58,
    blocks: [
      { id: 'q', type: 'qr', enabled: true, url: 'https://mandalikaperfume.co.id/x', align: 'center' },
      { id: 'i', type: 'items', enabled: true },
      { id: 'o', type: 'totals', enabled: true, showSubtotal: true, showDiscount: true, showTax: true },
      { id: 'p', type: 'payment', enabled: true },
    ],
  }
  const capture = () => {
    const writes: Uint8Array[] = []
    const t: PrinterTransport = {
      kind: 'none', isAvailable: async () => true, pickDevice: async () => null,
      connect: async () => {}, write: async (b) => { writes.push(b) }, disconnect: async () => {},
    }
    return { t, writes }
  }
  const has = (b: Uint8Array, seq: number[]) => b.some((_, i) => seq.every((v, j) => b[i + j] === v))

  it('graphics off prints the QR url as text on the sale', async () => {
    const { t, writes } = capture()
    await printReceipt({ transport: t, deviceId: 'd', data, settings, layout: qrLayout, graphics: false })
    expect(has(writes[0]!, [0x1d, 0x28, 0x6b])).toBe(false)
    expect(String.fromCharCode(...writes[0]!)).toContain('https://mandalikaperfume.co.id/x')
  })

  it('graphics on (the default) sends the QR commands', async () => {
    const { t, writes } = capture()
    await printReceipt({ transport: t, deviceId: 'd', data, settings, layout: qrLayout })
    expect(has(writes[0]!, [0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00])).toBe(true)
  })

  it('runExclusive frees the queue within DRAIN_MAX_MS + 1 s after the last write', async () => {
    vi.useFakeTimers()
    try {
      const started: number[] = []
      let written = 0
      const t: PrinterTransport = {
        kind: 'none', isAvailable: async () => true, pickDevice: async () => null,
        connect: async () => { started.push(Date.now()) },
        write: async (b) => { written += b.length },
        // the native disconnect sleeps the drain budget before it closes
        disconnect: async () => { await new Promise((r) => setTimeout(r, drainDelayMs(written))); written = 0 },
      }
      const big = { ...settings, copies: 5 }
      const first = printReceipt({ transport: t, deviceId: 'd', data, settings: big })
      const second = printReceipt({ transport: t, deviceId: 'd', data, settings: big })
      const lastWriteAt = Date.now()
      await vi.advanceTimersByTimeAsync(DRAIN_MAX_MS + 1000)
      await first
      expect(started).toHaveLength(2)
      expect(started[1]! - lastWriteAt).toBeLessThanOrEqual(DRAIN_MAX_MS + 1000)
      await vi.advanceTimersByTimeAsync(DRAIN_MAX_MS + 1000)
      await second
    } finally {
      vi.useRealTimers()
    }
  })
})
