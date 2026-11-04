import { Pagination } from '../../ui/Pagination'
import { totalPagesOf } from './reportFilters'

interface ReportPagerProps {
  page: number
  total: number
  /** The server page size this report always asks for. */
  limit: number
  onChange: (page: number) => void
}

/** The kit pager for a report whose page size is fixed by the server contract (no `per` in its URL): the size select offers only that size. */
export function ReportPager({ page, total, limit, onChange }: ReportPagerProps) {
  const totalPages = totalPagesOf(total, limit)
  if (totalPages <= 1) return null
  return (
    <Pagination
      page={page}
      totalPages={totalPages}
      total={total}
      onChange={onChange}
      pageSize={limit}
      onPageSizeChange={() => {}}
      pageSizes={[limit]}
    />
  )
}
