/**
 * Shown instead of the app when secure storage could not be loaded at boot.
 * Starting anyway would present an empty sale queue over data that may still
 * be on disk, so the app stops here and asks for a retry.
 */
export function BootError({ detail }: { detail: string }) {
  return (
    <div
      role="alert"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, minHeight: '100vh', padding: 24, textAlign: 'center', fontFamily: 'system-ui', color: '#111827' }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 800 }}>Penyimpanan perangkat tidak dapat dibaca</h1>
      <p style={{ maxWidth: 420, fontSize: 14, color: '#4b5563' }}>
        Aplikasi tidak dilanjutkan agar antrean transaksi yang belum tersinkron tidak hilang.
        Coba lagi; jika masih muncul, jangan lakukan transaksi dan hubungi admin.
      </p>
      <p style={{ maxWidth: 420, fontSize: 11, color: '#9ca3af' }}>{detail}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{ padding: '10px 20px', borderRadius: 12, background: '#b45309', color: '#fff', fontWeight: 700, border: 0 }}
      >
        Coba lagi
      </button>
    </div>
  )
}
