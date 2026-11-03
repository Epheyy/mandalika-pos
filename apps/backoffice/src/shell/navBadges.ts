import { useApprovalCount } from '../screens/approvals/useApprovalCount'
import { useOversellOpenCount } from '../screens/reports/useOversellOpenCount'
import { useSyncReviewCount } from '../screens/syncReview/useSyncReviewCount'
import type { NavUser } from '../lib/navAccess'
import type { NavId, RouteDef } from '../lib/router/routes'
import { badgeFor, type NavBadge } from './navBadgeModel'

/** The three polled counts, each fetched only when its menu item is visible to this user. */
export function useNavBadges(visible: readonly RouteDef[], user: NavUser | null, outletId: string | null): (id: NavId) => NavBadge | null {
  const review = useSyncReviewCount(visible.some((r) => r.id === 'syncReview'))
  const approval = useApprovalCount(visible.some((r) => r.id === 'approvals'))
  // Same count as the "Stok Minus" tab badge (A44): unchecked oversell lines in scope.
  const oversell = useOversellOpenCount(
    user?.role === 'admin' || (user?.permissions ?? []).includes('view_reports'),
    outletId,
  )
  return (id) => badgeFor(id, { review, approval, oversell })
}
