import type { ErpOutboxItem } from '@mandalika/api'
import { Badge } from '../../ui/Badge'
import { fmtTime } from './fmtTime'
import { kindLabel, locationText, refText, statusLabel, statusTone } from './erpOutboxFormat'

interface Props {
  rows: ErpOutboxItem[]
  onOpen: (row: ErpOutboxItem) => void
}

export function StatusBadge({ status }: { status: ErpOutboxItem['status'] }) {
  return <Badge tone={statusTone(status)} className="uppercase">{statusLabel(status)}</Badge>
}

export function ErpOutboxTable({ rows, onOpen }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] font-black text-gray-400 uppercase tracking-wider">
            <th className="px-4 py-3">Waktu</th>
            <th className="px-4 py-3">Jenis</th>
            <th className="px-4 py-3">Ref</th>
            <th className="px-4 py-3">Lokasi</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Percobaan</th>
            <th className="px-4 py-3">HTTP</th>
            <th className="px-4 py-3">Alasan</th>
            <th className="px-4 py-3"><span className="sr-only">Aksi</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((r) => {
            const reason = r.holdReason || r.lastError || ''
            return (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 whitespace-nowrap text-gray-600">{fmtTime(r.createdAt)}</td>
                <td className="px-4 py-3 font-semibold text-gray-900">{kindLabel(r.kind)}</td>
                <td className="px-4 py-3 text-gray-700">{refText(r)}</td>
                <td className="px-4 py-3 text-gray-500">{locationText(r)}</td>
                <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                <td className="px-4 py-3 text-right">{r.attempts}</td>
                <td className="px-4 py-3">{r.lastHttpStatus ?? '—'}</td>
                <td className="px-4 py-3 max-w-[16rem] truncate text-gray-500" title={reason}>{reason || '—'}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onOpen(r)}
                    aria-label={`Lihat detail dokumen ${refText(r)}`}
                    className="text-xs font-bold text-gold-700 hover:underline"
                  >
                    Detail
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
