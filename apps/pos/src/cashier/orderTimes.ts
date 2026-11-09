/**
 * F12/F26: one rule for the time shown on an order row. The main time is when the sale
 * happened (the tablet's clientCreatedAt, createdAt when the row has none). When the
 * server heard of it noticeably later, that is a second, labelled time. The words
 * "Hari ini"/"Kemarin" are never used here: they belong to the shift-day chips.
 */
import type { components } from '@mandalika/api'
import { zoneParts } from './promoValidate'

type Order = components['schemas']['Order']

/** A server receive later than this after the sale counts as an offline sale. */
export const RECEIVED_LATE_MS = 5 * 60_000

/** The backend trusts a tablet time only within [server - 7 days, server + 5 minutes] (business date, offline cap); so does this display. */
const MAX_CLIENT_AGE_MS = 7 * 86_400_000

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']

export interface OrderTimeLabels {
  /** When the sale happened, e.g. "09 Nov 01:31". */
  main: string
  /** "Diterima server 08:46" for an offline sale; null when the server heard it right away. */
  received: string | null
}

/** "09 Nov 01:31" on the outlet clock; the year is added only when it is not the current one. */
function stamp(at: Date, timezone: string | null | undefined, now: Date): string {
  const { dateStr, hhmm } = zoneParts(at, timezone)
  const [y, m, d] = dateStr.split('-')
  const year = y === zoneParts(now, timezone).dateStr.slice(0, 4) ? '' : ` ${y}`
  return `${d} ${MONTHS[Number(m) - 1]}${year} ${hhmm}`
}

export function orderTimeLabels(
  order: Pick<Order, 'createdAt' | 'clientCreatedAt'>,
  timezone: string | null | undefined,
  now: Date = new Date(),
): OrderTimeLabels {
  const server = new Date(order.createdAt)
  const client = order.clientCreatedAt ? new Date(order.clientCreatedAt) : null
  const trusted = client !== null && !Number.isNaN(client.getTime()) && !Number.isNaN(server.getTime())
    && client.getTime() >= server.getTime() - MAX_CLIENT_AGE_MS && client.getTime() <= server.getTime() + RECEIVED_LATE_MS
  const sale = trusted && client ? client : server
  if (Number.isNaN(sale.getTime())) return { main: '-', received: null }
  const main = stamp(sale, timezone, now)
  if (Number.isNaN(server.getTime()) || server.getTime() - sale.getTime() <= RECEIVED_LATE_MS) return { main, received: null }
  const sameDay = zoneParts(server, timezone).dateStr === zoneParts(sale, timezone).dateStr
  const when = sameDay ? zoneParts(server, timezone).hhmm : stamp(server, timezone, now)
  return { main, received: `Diterima server ${when}` }
}
