import { beforeEach, describe, expect, it, vi } from 'vitest'

const cap = vi.hoisted(() => ({ platform: 'web' }))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => cap.platform,
    isNativePlatform: () => cap.platform !== 'web',
  },
  registerPlugin: () => ({}),
}))

import { createTransport, printReceipt } from './print'
import type { PrinterTransport } from './transport'
import type { PrintJob } from './print'

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
    const bad = recorder({ connectFail: new Error('x') })
    const good = recorder()
    await expect(
      printReceipt({ transport: bad.t, deviceId: 'AA', data, settings }),
    ).rejects.toThrow(/^Gagal/)
    await printReceipt({ transport: good.t, deviceId: 'AA', data, settings })
    expect(good.calls).toEqual(['connect', 'write', 'disconnect'])
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
