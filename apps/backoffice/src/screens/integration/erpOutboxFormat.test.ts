import { describe, expect, it } from 'vitest'
import {
  ALL_STATUSES, canRetry, emptyTitle, kindFilterOf, kindLabel, locationText, refText, relaySummary, retryConsequence,
  showsNextAttempt, statusFilterOf, STATUS_LABEL, STATUS_ORDER,
  humanReason,
} from './erpOutboxFormat'

const report = { disabled: false, claimed: 6, delivered: 3, replayed: 1, held: 2, retried: 1, dead: 4, released: 0 }

describe('erpOutboxFormat', () => {
  it('labels statuses and kinds in Indonesian', () => {
    expect(STATUS_LABEL.dead).toBe('Gagal')
    expect(STATUS_LABEL.replayed).toBe('Diulang')
    expect(kindLabel('transfer_cancel')).toBe('Batal transfer')
    expect(kindLabel('write_off')).toBe('Penghapusan')
  })
  it('formats refs with part suffix only when split', () => {
    const base = { refNumber: 'INV-1', refId: '12345678-aaaa', part: 1, partCount: 1 }
    expect(refText(base)).toBe('INV-1')
    expect(refText({ ...base, part: 2, partCount: 3 })).toBe('INV-1 (bagian 2/3)')
    expect(refText({ ...base, refNumber: null })).toBe('12345678')
  })
  it('shows the location name and falls back to type and short id when the location is gone', () => {
    const loc = { locationType: 'outlet' as const, locationId: 'abcdef12-0000' }
    expect(locationText({ ...loc, locationName: 'Outlet BSD' })).toBe('Outlet BSD')
    expect(locationText({ ...loc, locationName: null })).toBe('Outlet abcdef12')
    expect(locationText({ ...loc, locationName: '  ' })).toBe('Outlet abcdef12')
    expect(locationText({ locationType: 'warehouse', locationId: '99887766-1' })).toBe('Gudang 99887766')
  })
  it('keeps the "Semua" status distinct from the default and from junk in the URL', () => {
    expect(statusFilterOf('dead')).toBe('dead')
    expect(statusFilterOf(ALL_STATUSES)).toBeUndefined()
    expect(statusFilterOf('bogus')).toBeUndefined()
    expect(kindFilterOf('sale')).toBe('sale')
    expect(kindFilterOf('bogus')).toBe('')
  })
  it('summarises a run as three counts with no setting names', () => {
    const s = relaySummary(report)
    expect(s.disabled).toBe(false)
    expect(s.counts).toEqual([
      { label: 'Terkirim', value: 4 },
      { label: 'Ditahan', value: 2 },
      { label: 'Gagal', value: 4 },
    ])
    expect(s.headline).toBeNull()
    expect(s.technical).toContain('Dijadwalkan ulang 1')
    expect(JSON.stringify(s.counts) + (s.headline ?? '')).not.toMatch(/ERP_/)
  })
  it('keeps setting names out of the visible text when the relay is off', () => {
    const off = relaySummary({ ...report, disabled: true, reason: 'ERP_RELAY_ENABLED is off' })
    expect(off.disabled).toBe(true)
    expect(off.counts).toEqual([])
    expect(off.headline).toBe('Relay nonaktif: pengiriman ke ERP dimatikan di server.')
    expect(off.headline).not.toMatch(/ERP_/)
    expect(off.technical.join(' ')).toContain('ERP_RELAY_ENABLED')
    const bad = relaySummary({ ...report, disabled: true, reason: 'invalid ERP relay config' })
    expect(bad.headline).toContain('konfigurasi ERP di server tidak valid')
    expect(bad.headline).not.toMatch(/ERP_/)
    expect(bad.technical.join(' ')).toContain('ERP_BASE_URL')
  })
  it('surfaces why a run stopped', () => {
    const stopped = { ...report, delivered: 0, held: 0, retried: 0, released: 2, stopped: 'unauthorized' as const }
    expect(relaySummary(stopped).headline).toContain('kunci API ERP ditolak (401)')
    expect(relaySummary({ ...stopped, stopped: 'budget' as const }).headline).toContain('batas waktu run habis')
  })
  it('says a 400/422 rebuilds the document and anything else resends the same body', () => {
    expect(retryConsequence({ status: 'dead', lastHttpStatus: 422 })).toContain('dibangun ulang dari pemetaan terkini')
    expect(retryConsequence({ status: 'dead', lastHttpStatus: 400 })).toContain('dibangun ulang dari pemetaan terkini')
    expect(retryConsequence({ status: 'dead', lastHttpStatus: 503 })).toContain('Isi yang sama dikirim lagi')
    expect(retryConsequence({ status: 'held', lastHttpStatus: null })).toContain('Isi yang sama dikirim lagi')
    expect(retryConsequence({ status: 'delivered', lastHttpStatus: 200 })).toContain('sudah ditandai terkirim')
    expect(retryConsequence({ status: 'dead', lastHttpStatus: 503 })).not.toContain('sudah ditandai terkirim')
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

describe('humanReason', () => {
  const base = { holdReason: null, lastError: null, lastHttpStatus: null }
  it('says nothing when there is no reason', () => {
    expect(humanReason(base)).toBeNull()
  })
  it('puts a held document in plain words, never the raw reason', () => {
    expect(humanReason({ ...base, holdReason: 'unmapped sku X-1' })).toBe('Ditahan, menunggu ditinjau')
  })
  it('names who is at fault by HTTP class', () => {
    expect(humanReason({ ...base, lastHttpStatus: 503, lastError: 'ERP down' })).toBe('ERP sedang bermasalah (HTTP 503)')
    expect(humanReason({ ...base, lastHttpStatus: 422, lastError: '{"detail":"x"}' })).toBe('ERP menolak dokumen (HTTP 422)')
  })
  it('access and busy statuses are not blamed on the document', () => {
    expect(humanReason({ ...base, lastHttpStatus: 403, lastError: 'x' })).toBe('ERP menolak akses (HTTP 403), periksa kredensial')
    expect(humanReason({ ...base, lastHttpStatus: 429, lastError: 'x' })).toBe('ERP sibuk, akan dicoba lagi (HTTP 429)')
  })
  it('a failure with no HTTP status is a generic send failure', () => {
    expect(humanReason({ ...base, lastError: 'ECONNRESET' })).toBe('Gagal mengirim ke ERP')
  })
})
