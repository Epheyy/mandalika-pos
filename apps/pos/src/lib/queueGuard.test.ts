import { describe, expect, it } from 'vitest'
import { queueBlockReason, queueCountsLine } from './queueGuard'

describe('queueCountsLine', () => {
  it('says everything is sent when both counts are zero', () => {
    expect(queueCountsLine({ pending: 0, parked: 0 })).toEqual({ text: 'Semua transaksi sudah terkirim', tone: 'ok' })
  })
  it('joins both counts, danger when anything is parked', () => {
    expect(queueCountsLine({ pending: 3, parked: 1 })).toEqual({ text: '3 transaksi tersimpan di tablet, 1 perlu ditinjau', tone: 'danger' })
  })
  it('drops a zero part and is a warning when only queued', () => {
    expect(queueCountsLine({ pending: 2, parked: 0 })).toEqual({ text: '2 transaksi tersimpan di tablet', tone: 'warn' })
    expect(queueCountsLine({ pending: 0, parked: 2 }).text).toBe('2 perlu ditinjau')
  })
})

describe('queueBlockReason', () => {
  const c = { pending: 0, parked: 0, parkedUnstamped: 0 }
  it('prefers the admin reason, then waiting, then internet', () => {
    expect(queueBlockReason({ pending: 2, parked: 1, parkedUnstamped: 1 })).toBe('Hubungi admin untuk yang perlu ditinjau')
    expect(queueBlockReason({ ...c, pending: 2 })).toBe('Tunggu sampai terkirim')
    expect(queueBlockReason(c, { needsOnline: true, online: false })).toBe('Butuh internet')
  })
  it('is null when nothing blocks', () => {
    expect(queueBlockReason(c, { needsOnline: true, online: true })).toBeNull()
    expect(queueBlockReason({ ...c, parked: 1 })).toBeNull() // stamped parked items do not block
  })
})
