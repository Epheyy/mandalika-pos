interface HeaderSearchProps {
  value: string
  onChange: (q: string) => void
  /** Enter submits (keyboard-wedge scanners append CR). */
  onSubmit: (q: string) => void
  /** Camera scan; the gold "Pindai" action is hidden when absent. */
  onScan?: () => void
}

/** Product search + scan inside the glass header bar, next to the brand (W1-02). */
export function HeaderSearch({ value, onChange, onSubmit, onScan }: HeaderSearchProps) {
  return (
    <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-chip border border-paper-2 bg-white px-3 focus-within:ring-2 focus-within:ring-paper-2">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-ink-500">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit(value)
          }
        }}
        placeholder="Cari nama, SKU, atau barcode"
        aria-label="Cari atau scan produk"
        className="h-11 min-w-0 flex-1 bg-transparent text-base text-ink-900 placeholder:text-ink-500 focus:outline-none"
      />
      {onScan && (
        <button
          type="button"
          onClick={onScan}
          className="press min-h-11 flex-shrink-0 px-1 text-sm font-bold text-brand-strong"
          title="Scan barcode / QR"
          aria-label="Scan barcode atau QR"
        >
          Pindai
        </button>
      )}
    </div>
  )
}
