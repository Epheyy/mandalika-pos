export interface PaymentMethodSwitchProps {
  /** The enabled methods, already labelled for display. */
  methods: readonly { id: string; label: string }[]
  selected: string
  disabled?: boolean
  onChange: (id: string) => void
}

/** Segmented method switch (W2-07): grey track, white raised thumb. Wraps to more rows instead of overflowing its column. */
export function PaymentMethodSwitch({ methods, selected, disabled, onChange }: PaymentMethodSwitchProps) {
  return (
    <div
      role="group"
      aria-label="Metode pembayaran"
      className="grid grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))] gap-1 rounded-sheet bg-ink-900/5 p-1"
    >
      {methods.map((m) => (
        <button
          key={m.id}
          type="button"
          disabled={disabled}
          aria-pressed={selected === m.id}
          onClick={() => onChange(m.id)}
          className={`press min-h-11 min-w-0 break-words rounded-control px-2 text-base font-semibold leading-tight disabled:opacity-50 ${
            selected === m.id ? 'bg-white text-brand-strong shadow-sm' : 'text-ink-700'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
