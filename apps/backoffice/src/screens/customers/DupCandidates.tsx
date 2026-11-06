import type { DupCandidate } from '@mandalika/api'
import type { ListResult } from '@mandalika/api'
import { Users } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'

interface DupCandidatesProps {
  onReview: (id: string) => void
  refreshKey: number
}

export default function DupCandidates({ onReview, refreshKey }: DupCandidatesProps) {
  const q = usePolledQuery<ListResult<DupCandidate>>(
    () => api.listDupCandidates('pending', 1, 50),
    [refreshKey],
  )
  const candidates = q.data?.data ?? []

  return (
    <Card className="overflow-clip">
      {q.loading && candidates.length === 0 ? (
        <TableSkeleton />
      ) : candidates.length === 0 ? (
        <EmptyState icon={<Users />} title="Tidak ada duplikat untuk ditinjau." />
      ) : (
        <div className="divide-y divide-paper-1">
          {candidates.map((c: DupCandidate) => (
            <div key={c.id} className="px-5 py-4 flex items-center justify-between gap-4 hover:bg-paper-1">
              <div className="flex-1 min-w-0">
                <p className="font-bold text-ink-900 text-sm">
                  {c.existingCustomer.name}
                  <span className="mx-2 text-ink-500">↔</span>
                  {c.newCustomer.name}
                </p>
                <p className="text-xs text-ink-500">
                  {c.phone} · {new Date(c.createdAt).toLocaleDateString('id-ID')}
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => onReview(c.id)}>
                Tinjau
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
