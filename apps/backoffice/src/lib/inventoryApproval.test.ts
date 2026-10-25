import { describe, expect, it } from 'vitest'
import { ApiError } from '@mandalika/api'
import {
  adjustmentDelta,
  adjustmentDrift,
  approveErrorMessage,
  buildSubmitLines,
  varianceLines,
  composeReason,
  countStatusLabel,
  countStatusTone,
  isApprovalRequired,
  isValidPin,
  reasonLabel,
  signed,
  validateReason,
} from './inventoryApproval'

describe('inventoryApproval helpers', () => {
  it('maps reason codes to Indonesian labels', () => {
    expect(reasonLabel('damaged')).toBe('Rusak')
    expect(reasonLabel('tester_sample')).toBe('Tester/sampel')
    expect(reasonLabel('count_variance')).toBe('Selisih opname')
    expect(reasonLabel(undefined)).toBe('-')
  })

  it('requires text only for Lainnya', () => {
    expect(validateReason('', '')).toBe('Pilih alasan.')
    expect(validateReason('other', '  ')).toMatch(/wajib/)
    expect(validateReason('other', 'x')).toBeNull()
    expect(validateReason('lost', '')).toBeNull()
  })

  it('composes the direct-adjust reason from label and text', () => {
    expect(composeReason('lost', '')).toBe('Hilang')
    expect(composeReason('damaged', ' botol pecah ')).toBe('Rusak: botol pecah')
  })

  it('labels and tones every count status including pending_approval', () => {
    expect(countStatusLabel('pending_approval')).toBe('Menunggu Persetujuan')
    expect(countStatusLabel('completed')).toBe('Selesai')
    expect(countStatusTone('pending_approval')).toBe('warning')
    expect(countStatusTone('cancelled')).toBe('danger')
  })

  it('computes the applied delta and live drift', () => {
    expect(adjustmentDelta(10, 7)).toBe(-3)
    expect(adjustmentDrift(10, 12)).toBe(2)
    expect(adjustmentDrift(10, undefined)).toBe(0)
    expect(signed(3)).toBe('+3')
    expect(signed(-2)).toBe('-2')
    expect(signed(0)).toBe('0')
  })

  it('validates a 4-8 digit PIN', () => {
    expect(isValidPin('1234')).toBe(true)
    expect(isValidPin('12345678')).toBe(true)
    expect(isValidPin('123')).toBe(false)
    expect(isValidPin('12a4')).toBe(false)
  })

  it('detects approval_required 409 and maps approve errors', () => {
    expect(isApprovalRequired(new ApiError(409, 'x', 'http', { data: { code: 'approval_required' } }))).toBe(true)
    expect(isApprovalRequired(new ApiError(409, 'x', 'http', { error: 'x' }))).toBe(false)
    expect(approveErrorMessage(new ApiError(403, 'x'))).toBe('PIN salah atau penyetuju tidak berwenang.')
    expect(approveErrorMessage(new ApiError(429, 'x', 'http', { retryAfterSeconds: 90 }))).toMatch(/2 menit/)
    expect(approveErrorMessage(new ApiError(429, 'x', 'http', { hardLocked: true }))).toMatch(/terkunci/)
    expect(approveErrorMessage(new ApiError(409, 'sudah diproses'))).toBe('sudah diproses')
  })

  it('finds variance lines and keeps only lines with a reason code', () => {
    const mk = (size: string, frozen: number, actual: number | null) =>
      ({ productId: 'p', productName: 'P', variantSize: size, sku: '', frozenQty: frozen, actualQty: actual })
    const lines = varianceLines([mk('a', 5, 5), mk('b', 5, 3), mk('c', 5, null)])
    expect(lines.map((l) => [l.item.variantSize, l.diff])).toEqual([['b', -2]])
    const out = buildSubmitLines(lines, { 'p|b': { code: 'other', text: ' x ' } })
    expect(out).toEqual([{ productId: 'p', variantSize: 'b', reasonCode: 'other', reasonText: 'x' }])
    expect(buildSubmitLines(lines, {})).toEqual([])
  })
})
