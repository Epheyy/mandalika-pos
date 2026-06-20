/**
 * Blocking modal raised when wall.raised is true (server version > local version).
 * Per plan §5a:
 *   - NEVER blocks outbox flush (pending revenue must never be trapped).
 *   - Blocks STARTING A NEW SALE (disable checkout/add-to-cart-confirm while raised).
 *   - Resync = pull delta, atomically swap snapshot, clear wall.
 */

import { memo } from 'react'
import type { WallState } from '@mandalika/sync'

interface SyncWallProps {
  wall: WallState
  isResyncing: boolean
  pendingCount: number
  isOnline: boolean
  lastSyncedAt: string | null
  onResync: () => void
  onFlush: () => void
}

export const SyncWall = memo(function SyncWall({
  wall,
  isResyncing,
  pendingCount,
  isOnline,
  lastSyncedAt,
  onResync,
  onFlush,
}: SyncWallProps) {
  // Offline status banner (always visible, not a blocking wall)
  const offlineBanner = !isOnline ? (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        background: '#f59e0b',
        color: '#fff',
        textAlign: 'center',
        fontSize: 12,
        padding: '6px 16px',
        fontWeight: 600,
      }}
    >
      ⚠ Offline — menjual dari data terakhir
      {pendingCount > 0 && ` · ${pendingCount} order menunggu sinkronisasi`}
    </div>
  ) : null

  if (!wall.raised) {
    return (
      <>
        {offlineBanner}
        {/* Pending count indicator in top-right when online */}
        {isOnline && pendingCount > 0 && (
          <div
            style={{
              position: 'fixed',
              top: 8,
              right: 16,
              zIndex: 99,
              background: '#f59e0b',
              color: '#fff',
              borderRadius: 999,
              fontSize: 11,
              padding: '2px 8px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
            onClick={onFlush}
            title="Klik untuk sinkronisasi"
          >
            {pendingCount} menunggu ↑
          </div>
        )}
        {lastSyncedAt && (
          <div
            style={{
              position: 'fixed',
              bottom: 8,
              right: 16,
              zIndex: 99,
              fontSize: 10,
              color: '#9ca3af',
              pointerEvents: 'none',
            }}
          >
            Sync:{' '}
            {new Date(lastSyncedAt).toLocaleTimeString('id-ID', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
        )}
      </>
    )
  }

  // Wall is raised — show blocking modal
  return (
    <>
      {offlineBanner}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 200,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
        }}
      >
        <div
          style={{
            background: '#fff',
            borderRadius: 20,
            padding: 28,
            maxWidth: 380,
            width: '100%',
            boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 999,
              background: '#fef3c7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
              fontSize: 24,
            }}
          >
            🔄
          </div>

          <h2
            style={{
              margin: '0 0 8px',
              fontSize: 17,
              fontWeight: 800,
              color: '#111827',
            }}
          >
            Pembaruan Data POS
          </h2>

          <p
            style={{
              margin: '0 0 4px',
              fontSize: 13,
              color: '#6b7280',
              lineHeight: 1.5,
            }}
          >
            Backoffice telah memperbarui data POS. Sinkronisasi diperlukan
            sebelum memulai transaksi baru.
          </p>

          <p
            style={{
              margin: '0 0 20px',
              fontSize: 11,
              color: '#9ca3af',
            }}
          >
            Versi lokal: {wall.localVersion} · Server: {wall.serverVersion}
          </p>

          {!isOnline && (
            <div
              style={{
                background: '#fef3c7',
                borderRadius: 12,
                padding: '10px 14px',
                marginBottom: 16,
                fontSize: 12,
                color: '#92400e',
              }}
            >
              Offline — tidak dapat sinkronisasi sekarang. Sambungkan ke
              internet untuk memperbarui.
            </div>
          )}

          {pendingCount > 0 && (
            <div
              style={{
                background: '#f0fdf4',
                borderRadius: 12,
                padding: '10px 14px',
                marginBottom: 16,
                fontSize: 12,
                color: '#166534',
              }}
            >
              {pendingCount} transaksi tertunda akan disinkronisasi terlebih
              dahulu.
              {isOnline && (
                <button type="button"
                  onClick={onFlush}
                  style={{
                    display: 'block',
                    marginTop: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#166534',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  Kirim sekarang →
                </button>
              )}
            </div>
          )}

          <button type="button"
            onClick={onResync}
            disabled={isResyncing || !isOnline}
            style={{
              width: '100%',
              padding: '12px 0',
              background: isResyncing || !isOnline ? '#9ca3af' : '#4f46e5',
              color: '#fff',
              border: 'none',
              borderRadius: 12,
              fontSize: 14,
              fontWeight: 700,
              cursor: isResyncing || !isOnline ? 'not-allowed' : 'pointer',
              transition: 'background 0.2s',
            }}
          >
            {isResyncing
              ? 'Menyinkronisasi…'
              : !isOnline
                ? 'Perlu Koneksi Internet'
                : 'Sinkronisasi Sekarang'}
          </button>
        </div>
      </div>
    </>
  )
})
