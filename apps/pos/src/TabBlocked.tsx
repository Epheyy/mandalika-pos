/**
 * Shown in a second browser tab instead of the app (F22/W01). Two tabs of one browser profile share the same
 * storage, so only one may run the POS at a time. Nothing here reads storage, the sync engine or the cart; the
 * app starts by itself when the other tab is closed.
 */
export function TabBlocked() {
  return (
    <div
      role="alert"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, minHeight: '100vh', padding: 24, textAlign: 'center', fontFamily: 'system-ui', color: '#111827' }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 800 }}>POS sudah terbuka di tab lain</h1>
      <p style={{ maxWidth: 420, fontSize: 14, color: '#4b5563' }}>
        Satu browser hanya boleh menjalankan satu kasir agar keranjang dan antrean transaksi tidak saling menimpa.
        Lanjutkan di tab yang sudah terbuka, atau tutup tab itu. Halaman ini akan terbuka sendiri setelahnya. Memuat ulang tab yang aktif memindahkan kasir ke tab ini.
      </p>
    </div>
  )
}
