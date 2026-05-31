import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { cn } from './cn'

/** Shared control styling so every input/select/textarea matches. */
export const fieldClass =
  'w-full px-3 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-900 ' +
  'placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gold-500/40 ' +
  'focus:border-gold-400 transition'

const labelClass = 'block text-xs font-black text-gray-400 uppercase tracking-widest mb-2'

interface FieldShellProps {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
}

/** Label + control + hint/error wrapper. Error takes precedence over hint. */
export function Field({ label, hint, error, children }: FieldShellProps) {
  return (
    <div>
      {label && <label className={labelClass}>{label}</label>}
      {children}
      {error ? (
        <p className="text-[11px] text-red-600 mt-1">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-gray-400 mt-1">{hint}</p>
      ) : null}
    </div>
  )
}

type FieldExtras = { label?: ReactNode; hint?: ReactNode; error?: ReactNode }

export function Input({
  label,
  hint,
  error,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & FieldExtras) {
  return (
    <Field label={label} hint={hint} error={error}>
      <input className={cn(fieldClass, !!error && 'border-red-300', className)} {...rest} />
    </Field>
  )
}

export function Textarea({
  label,
  hint,
  error,
  className,
  rows = 3,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldExtras) {
  return (
    <Field label={label} hint={hint} error={error}>
      <textarea
        rows={rows}
        className={cn(fieldClass, 'resize-none', !!error && 'border-red-300', className)}
        {...rest}
      />
    </Field>
  )
}

export function Select({
  label,
  hint,
  error,
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & FieldExtras) {
  return (
    <Field label={label} hint={hint} error={error}>
      <select className={cn(fieldClass, !!error && 'border-red-300', className)} {...rest}>
        {children}
      </select>
    </Field>
  )
}
