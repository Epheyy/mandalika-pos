import { describe, expect, it } from 'vitest'
import { chipModel, type ChipInput } from './connectionChip'

const base: ChipInput = {
  reachable: true, offlineLevel: 'ok', pending: 0, stuck: 0, parked: 0,
  accountIssue: false, updating: false, wallRaised: false,
}
const chip = (over: Partial<ChipInput>) => chipModel({ ...base, ...over })

describe('chipModel online', () => {
  it('empty queue is Online · Tersinkron (ok)', () => {
    expect(chip({})).toEqual({ text: 'Online · Tersinkron', tone: 'ok' })
  })
  it('stock waiting for an update is info, and only when nothing louder is pending', () => {
    expect(chip({ stockPending: true })).toEqual({ text: 'Stok menunggu diperbarui', tone: 'info' })
    expect(chip({ stockPending: false }).text).toBe('Online · Tersinkron')
    expect(chip({ stockPending: true, wallRaised: true }).text).toBe('Data baru siap · perbarui')
    expect(chip({ stockPending: true, updating: true }).text).toBe('Memperbarui data…')
    expect(chip({ stockPending: true, pending: 2 }).text).toBe('Mengirim 2…')
    expect(chip({ stockPending: true, reachable: false }).text).toBe('Offline · aman')
  })
  it('sending N is info', () => {
    expect(chip({ pending: 3 })).toEqual({ text: 'Mengirim 3…', tone: 'info' })
  })
  it('stuck N is warn', () => {
    expect(chip({ stuck: 2, pending: 2 })).toEqual({ text: '2 tertunda', tone: 'warn' })
  })
  it('parked N is danger', () => {
    expect(chip({ parked: 1 })).toEqual({ text: '1 perlu ditinjau', tone: 'danger' })
  })
  it('account issue is danger', () => {
    expect(chip({ accountIssue: true, pending: 2 })).toEqual({ text: 'Masalah akun', tone: 'danger' })
  })
  it('parked outranks account, account outranks stuck, stuck outranks sending', () => {
    expect(chip({ parked: 1, accountIssue: true }).text).toBe('1 perlu ditinjau')
    expect(chip({ accountIssue: true, stuck: 1 }).text).toBe('Masalah akun')
    expect(chip({ stuck: 1, pending: 4 }).text).toBe('1 tertunda')
  })
  it('wall raised with an empty queue is info', () => {
    expect(chip({ wallRaised: true })).toEqual({ text: 'Data baru siap · perbarui', tone: 'info' })
  })
  it('updating is info, below queue states', () => {
    expect(chip({ updating: true })).toEqual({ text: 'Memperbarui data…', tone: 'info' })
    expect(chip({ updating: true, wallRaised: true }).text).toBe('Memperbarui data…')
    expect(chip({ updating: true, pending: 1 }).text).toBe('Mengirim 1…')
  })
})

describe('chipModel offline', () => {
  const off = { reachable: false }
  it('empty queue: Offline · aman (warn)', () => {
    expect(chip(off)).toEqual({ text: 'Offline · aman', tone: 'warn' })
  })
  it('queued N: Offline · N tersimpan', () => {
    expect(chip({ ...off, pending: 3 })).toEqual({ text: 'Offline · 3 tersimpan', tone: 'warn' })
  })
  it('stuck behaves like queued', () => {
    expect(chip({ ...off, pending: 2, stuck: 2 }).text).toBe('Offline · 2 tersimpan')
  })
  it('parked: Offline · N perlu ditinjau (danger)', () => {
    expect(chip({ ...off, parked: 2, pending: 5 })).toEqual({ text: 'Offline · 2 perlu ditinjau', tone: 'danger' })
  })
  it('account issue is danger', () => {
    expect(chip({ ...off, accountIssue: true })).toEqual({ text: 'Masalah akun', tone: 'danger' })
  })
  it('wallRaised/updating do not change the offline chip', () => {
    expect(chip({ ...off, wallRaised: true, updating: true }).text).toBe('Offline · aman')
  })
  it('offline-warn shows the hours', () => {
    expect(chip({ ...off, offlineLevel: 'warn', offlineHours: 10 })).toEqual({ text: 'Offline 10 jam · aman', tone: 'warn' })
    expect(chip({ ...off, offlineLevel: 'warn', offlineHours: 10, pending: 4 })).toEqual({ text: 'Offline 10 jam · 4 tersimpan', tone: 'warn' })
    expect(chip({ ...off, offlineLevel: 'warn', offlineHours: 11, parked: 1 })).toEqual({ text: 'Offline 11 jam · 1 perlu ditinjau', tone: 'danger' })
  })
  it('offline-locked is danger', () => {
    expect(chip({ ...off, offlineLevel: 'locked' })).toEqual({ text: 'Offline terkunci · hubungi admin', tone: 'danger' })
    expect(chip({ ...off, offlineLevel: 'locked', pending: 2 })).toEqual({ text: 'Offline terkunci · 2 tersimpan', tone: 'danger' })
    expect(chip({ ...off, offlineLevel: 'locked', parked: 1 })).toEqual({ text: 'Offline terkunci · 1 perlu ditinjau', tone: 'danger' })
  })
  it('unknown level behaves like ok', () => {
    expect(chip({ ...off, offlineLevel: 'unknown' }).text).toBe('Offline · aman')
  })
})

describe('chipModel while locked or warning (review follow-ups)', () => {
  it('online × locked is danger, never green', () => {
    expect(chip({ offlineLevel: 'locked' })).toEqual({ text: 'Terkunci · hubungi admin', tone: 'danger' })
    expect(chip({ offlineLevel: 'locked', pending: 2 }).tone).toBe('danger')
  })
  it('online × locked still shows parked and account problems first', () => {
    expect(chip({ offlineLevel: 'locked', parked: 1 }).text).toBe('1 perlu ditinjau')
    expect(chip({ offlineLevel: 'locked', accountIssue: true }).text).toBe('Masalah akun')
  })
  it('warn × stuck and locked × stuck read as queued while offline', () => {
    expect(chip({ reachable: false, offlineLevel: 'warn', offlineHours: 10, pending: 3, stuck: 3 }).text).toBe('Offline 10 jam · 3 tersimpan')
    expect(chip({ reachable: false, offlineLevel: 'locked', pending: 3, stuck: 3 }).text).toBe('Offline terkunci · 3 tersimpan')
  })
  it('account issue wins offline in warn and locked', () => {
    expect(chip({ reachable: false, offlineLevel: 'warn', accountIssue: true }).text).toBe('Masalah akun')
    expect(chip({ reachable: false, offlineLevel: 'locked', accountIssue: true }).text).toBe('Masalah akun')
  })
  it('falls back to 10 jam when the hours are unknown in warn', () => {
    expect(chip({ reachable: false, offlineLevel: 'warn' }).text).toBe('Offline 10 jam · aman')
  })
})

describe('chipModel by connection cause (A29)', () => {
  const off = { reachable: false } as const
  const causes = [
    ['no_internet', 'Tidak ada internet'],
    ['server_problem', 'Server bermasalah'],
  ] as const

  it.each(causes)('%s names its cause on an empty queue', (connection, prefix) => {
    expect(chip({ ...off, connection })).toEqual({ text: `${prefix} · aman`, tone: 'warn' })
  })
  it.each(causes)('%s with queued items', (connection, prefix) => {
    expect(chip({ ...off, connection, pending: 3 })).toEqual({ text: `${prefix} · 3 tersimpan`, tone: 'warn' })
    expect(chip({ ...off, connection, pending: 2, stuck: 2 }).text).toBe(`${prefix} · 2 tersimpan`)
  })
  it.each(causes)('%s with parked items stays danger', (connection, prefix) => {
    expect(chip({ ...off, connection, parked: 2, pending: 5 })).toEqual({ text: `${prefix} · 2 perlu ditinjau`, tone: 'danger' })
  })
  it.each(causes)('%s: the cap levels keep their own wording (they count both causes)', (connection) => {
    expect(chip({ ...off, connection, offlineLevel: 'warn', offlineHours: 10 }).text).toBe('Offline 10 jam · aman')
    expect(chip({ ...off, connection, offlineLevel: 'locked', pending: 2 })).toEqual({ text: 'Offline terkunci · 2 tersimpan', tone: 'danger' })
    expect(chip({ ...off, connection, offlineLevel: 'locked' }).text).toBe('Offline terkunci · hubungi admin')
  })
  it.each(causes)('%s: an account issue still wins', (connection) => {
    expect(chip({ ...off, connection, accountIssue: true }).text).toBe('Masalah akun')
  })
  it('an unknown or online cause while unreachable stays the plain Offline wording', () => {
    expect(chip({ ...off }).text).toBe('Offline · aman')
    expect(chip({ ...off, connection: 'online' }).text).toBe('Offline · aman')
  })
  it('the cause never changes an online chip', () => {
    expect(chip({ connection: 'server_problem' }).text).toBe('Online · Tersinkron')
  })
})
