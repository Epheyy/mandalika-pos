/**
 * F26: the time shown on an order is when the sale happened (the tablet's clientCreatedAt,
 * createdAt when the row has none). When the server heard of it noticeably later, that is a
 * second, labelled time. A server time is never presented as the sale time. Same rule and
 * wording as the POS history ("Diterima server"); here the browser's own zone is used.
 */
import { format, isSameDay, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import type { components } from '@mandalika/api'

type Order = components['schemas']['Order']
type OrderTimes = Pick<Order, 'createdAt' | 'clientCreatedAt' | 'businessDate'>

/** A server receive later than this after the sale counts as an offline sale. */
export const RECEIVED_LATE_MS = 5 * 60_000

export interface OrderTimeLabels {
  main: string
  received: string | null
}

/** The backend trusts a tablet time only within [server - 7 days, server + 5 minutes] (business date, offline cap); so does this display. */
const MAX_CLIENT_AGE_MS = 7 * 86_400_000

const valid = (d: Date) => !Number.isNaN(d.getTime())

function saleAndServer(o: Pick<Order, 'createdAt' | 'clientCreatedAt'>): { sale: Date; server: Date } {
  const server = parseISO(o.createdAt)
  const client = o.clientCreatedAt ? parseISO(o.clientCreatedAt) : null
  const trusted = client !== null && valid(client) && valid(server)
    && client.getTime() >= server.getTime() - MAX_CLIENT_AGE_MS && client.getTime() <= server.getTime() + RECEIVED_LATE_MS
  return { sale: trusted && client ? client : server, server }
}

export function orderTimeLabels(o: Pick<Order, 'createdAt' | 'clientCreatedAt'>): OrderTimeLabels {
  const { sale, server } = saleAndServer(o)
  if (!valid(sale)) return { main: '-', received: null }
  const main = format(sale, 'dd MMM yyyy HH:mm', { locale: idLocale })
  if (!valid(server) || server.getTime() - sale.getTime() <= RECEIVED_LATE_MS) return { main, received: null }
  const when = isSameDay(server, sale) ? format(server, 'HH:mm') : format(server, 'dd MMM HH:mm', { locale: idLocale })
  return { main, received: `Diterima server ${when}` }
}

const csvStamp = (d: Date) => (valid(d) ? format(d, 'yyyy-MM-dd HH:mm') : '')

/** Explicit CSV columns instead of one ambiguous "Tanggal". */
export function orderTimeCsv(o: OrderTimes): { 'Waktu Transaksi': string; 'Diterima Server': string; 'Hari Bisnis': string } {
  const { sale, server } = saleAndServer(o)
  return { 'Waktu Transaksi': csvStamp(sale), 'Diterima Server': csvStamp(server), 'Hari Bisnis': o.businessDate ?? '' }
}
