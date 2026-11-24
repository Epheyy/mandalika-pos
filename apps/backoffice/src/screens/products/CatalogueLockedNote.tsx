export const CATALOGUE_LOCKED_NOTE = 'Katalog hanya bisa diubah oleh admin atau Manajer Semua Outlet.'

/** Shown on the Produk / Kategori / Bundle screens and in the product editor when the signed-in user may only view the catalogue. */
export function CatalogueLockedNote({ className }: { className?: string }) {
  return (
    <p role="note" className={`rounded-xl bg-info-bg p-3 text-sm text-info${className ? ` ${className}` : ''}`}>
      {CATALOGUE_LOCKED_NOTE}
    </p>
  )
}
