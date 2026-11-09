/**
 * Persistent notice for a browser (never the APK) where the single-tab lock could not be taken (F22/W01 fail-open
 * case): the POS still runs, but nothing stops a second tab from overwriting the cart draft or the offline queue.
 * It sits at the bottom edge and ignores pointer events so it never blocks a tap on the cashier.
 */
export const TAB_GUARD_UNAVAILABLE_TEXT = 'Perlindungan satu tab tidak aktif di browser ini. Buka POS di satu tab saja.'

export function TabGuardUnavailableNotice() {
  return (
    <div
      role="status"
      data-testid="tab-guard-unavailable"
      style={{ position: 'fixed', left: '50%', bottom: 8, transform: 'translateX(-50%)', zIndex: 70, maxWidth: 'calc(100vw - 16px)', padding: '6px 12px', borderRadius: 8, background: '#92400e', color: '#fff', font: '600 12px/1.3 system-ui', textAlign: 'center', pointerEvents: 'none' }}
    >
      {TAB_GUARD_UNAVAILABLE_TEXT}
    </div>
  )
}
