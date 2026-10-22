import { describe, expect, it } from 'vitest'
import {
  canRetry, emptyTitle, kindLabel, locationText, refText, relayMessage, showsNextAttempt, statusLabel, statusTone, STATUS_ORDER,
} from './erpOutboxFormat'

const report = { disabled: false, claimed: 6, delivered: 3, replayed: 0, held: 2, retried: 1, dead: 0, released: 0 }

describe('erpOutboxFormat', () => {
  it('labels statuses and kinds in Indonesian', () => {
    expect(statusLabel('dead')).toBe('Gagal')
    expect(statusLabel('replayed')).toBe('Diulang')
    expect(kindLabel('transfer_cancel')).toBe('Batal transfer')
    expect(kindLabel('write_off')).toBe('Penghapusan')
  })
  it('maps statuses to semantic tones', () => {
    expect(statusTone('dead')).toBe('danger')
    expect(statusTone('held')).toBe('warning')
    expect(statusTone('delivered')).toBe('success')
    expect(statusTone('replayed')).toBe('success')
    expect(statusTone('pending')).toBe('neutral')
    expect(statusTone('sending')).toBe('neutral')
  })
  it('formats refs with part suffix only when split', () => {
    const base = { refNumber: 'INV-1', refId: '12345678-aaaa', part: 1, partCount: 1 }
    expect(refText(base)).toBe('INV-1')
    expect(refText({ ...base, part: 2, partCount: 3 })).toBe('INV-1 (bagian 2/3)')
    expect(refText({ ...base, refNumber: null })).toBe('12345678')
  })
  it('formats location with short id', () => {
    expect(locationText({ locationType: 'outlet', locationId: 'abcdef12-0000' })).toBe('outlet abcdef12')
  })
  it('formats the relay report incl. disabled', () => {
    expect(relayMessage(report)).toBe(
      'Terkirim 3, sudah ada di ERP 0, dijadwalkan ulang 1, ditahan 2, gagal 0, dikembalikan ke antrean 0')
    expect(relayMessage({ ...report, disabled: true, reason: 'ERP_RELAY_ENABLED is off' }))
      .toBe('Relay nonaktif (ERP_RELAY_ENABLED mati)')
    expect(relayMessage({ ...report, disabled: true, reason: 'invalid ERP relay config' }))
      .toContain('konfigurasi ERP tidak valid')
  })
  it('surfaces why a run stopped', () => {
    const stopped = { ...report, delivered: 0, held: 0, retried: 0, released: 2, stopped: 'unauthorized' as const }
    expect(relayMessage(stopped)).toContain('kunci API ERP ditolak (401)')
    expect(relayMessage({ ...stopped, stopped: 'budget' as const })).toContain('batas waktu run habis')
  })
  it('shows the next attempt only while it is pending or held', () => {
    expect(showsNextAttempt('pending')).toBe(true)
    expect(showsNextAttempt('held')).toBe(true)
    expect(showsNextAttempt('delivered')).toBe(false)
    expect(showsNextAttempt('dead')).toBe(false)
  })
  it('allows retry only from settled statuses', () => {
    expect(canRetry('dead')).toBe(true)
    expect(canRetry('delivered')).toBe(true)
    expect(canRetry('pending')).toBe(false)
    expect(canRetry('sending')).toBe(false)
  })
  it('titles empty states per filter', () => {
    expect(emptyTitle('dead')).toBe('Tidak ada dokumen gagal')
    expect(emptyTitle('')).toBe('Tidak ada dokumen')
    expect(emptyTitle('sending')).toBe('Tidak ada dokumen sedang dikirim')
  })
  it('orders the status tabs dead first and covers every status', () => {
    expect(STATUS_ORDER).toEqual(['dead', 'held', 'pending', 'sending', 'delivered', 'replayed'])
  })
})
