import { ToggleLeft, ToggleRight } from 'lucide-react'

/** Gold-toned on/off switch — semantic toggle for enable rows. */
export function Toggle({
  checked,
  onClick,
  label,
  size = 'md',
}: {
  checked: boolean
  onClick: () => void
  label: string
  size?: 'sm' | 'md'
}) {
  const cls = size === 'md' ? 'w-7 h-7' : 'w-6 h-6'
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={onClick} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500/40 rounded-lg">
      {checked ? (
        <ToggleRight className={`${cls} text-gold-600`} />
      ) : (
        <ToggleLeft className={`${cls} text-gray-400`} />
      )}
    </button>
  )
}
