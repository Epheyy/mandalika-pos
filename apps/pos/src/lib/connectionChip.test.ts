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
  it('queued N: Offline · N tersimpan di tablet', () => {
    expect(chip({ ...off, pending: 3 })).toEqual({ text: 'Offline · 3 tersimpan di tablet', tone: 'warn' })
  })
  it('stuck behaves like queued', () => {
    expect(chip({ ...off, pending: 2, stuck: 2 }).text).toBe('Offline · 2 tersimpan di tablet')
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
