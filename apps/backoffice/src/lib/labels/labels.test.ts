import { describe, expect, it } from 'vitest'
import type { ErpOutboxItem } from '@mandalika/api'
import * as labels from './index'
import { badgeTone, labelOf, type EnumLabel, type LabelMap } from './index'

const TONES = ['ok', 'warn', 'danger', 'info', 'neutral', 'promo', 'reward']

const MAPS: Record<string, LabelMap<string>> = {
  TRANSFER_STATUS: labels.TRANSFER_STATUS,
  REQUISITION_STATUS: labels.REQUISITION_STATUS,
  OPNAME_STATUS: labels.OPNAME_STATUS,
  ORDER_STATUS: labels.ORDER_STATUS,
  ERP_STATUS: labels.ERP_STATUS,
  ERP_KIND: labels.ERP_KIND,
  LEDGER_KIND: labels.LEDGER_KIND,
  LEDGER_BUCKET: labels.LEDGER_BUCKET,
  REASON_CODE: labels.REASON_CODE,
  SYNC_REVIEW_REASON: labels.SYNC_REVIEW_REASON,
  ROLE: labels.ROLE,
  ERROR_SOURCE: labels.ERROR_SOURCE,
  PAYMENT_METHOD: labels.PAYMENT_METHOD,
}

describe.each(Object.entries(MAPS))('%s', (_name, map) => {
  it('has a non-empty label and a valid tone on every entry', () => {
    for (const e of Object.values(map) as EnumLabel[]) {
      expect(e.label.trim()).not.toBe('')
      expect(TONES).toContain(e.tone)
    }
  })

  it('reads Lainnya for an unknown or missing code', () => {
    expect(labelOf(map, 'zz_unknown')).toEqual({ label: 'Lainnya', tone: 'neutral', hint: 'zz_unknown' })
    expect(labelOf(map, null).label).toBe('Lainnya')
  })
})

describe('coverage of API enums', () => {
  it('ERP_STATUS covers every outbox status', () => {
    const all: Record<ErpOutboxItem['status'], true> = { pending: true, held: true, sending: true, delivered: true, replayed: true, dead: true }
    expect(Object.keys(labels.ERP_STATUS).sort()).toEqual(Object.keys(all).sort())
  })

  it('ERP_KIND covers every outbox kind', () => {
    const all: Record<ErpOutboxItem['kind'], true> = {
      sale: true, refund: true, transfer_out: true, transfer_in: true, transfer_cancel: true,
      receipt: true, adjust: true, count: true, opening: true, write_off: true,
    }
    expect(Object.keys(labels.ERP_KIND).sort()).toEqual(Object.keys(all).sort())
  })
})

describe('unified wording', () => {
  it('uses the plan terminology', () => {
    expect(labels.TRANSFER_STATUS.completed.label).toBe('Diterima')
    expect(labels.ORDER_STATUS.refunded.label).toBe('Refund')
    expect(labels.ERP_KIND.refund.label).toBe('Refund')
    expect(labels.ERP_KIND.receipt.label).toBe('Barang Masuk')
    expect(labels.ROLE.manager.label).toBe('Manajer')
  })

  it('maps tones to the existing Badge names', () => {
    expect(badgeTone('ok')).toBe('success')
    expect(badgeTone('warn')).toBe('warning')
    expect(badgeTone('info')).toBe('gold')
    expect(badgeTone('promo')).toBe('neutral')
  })
})
