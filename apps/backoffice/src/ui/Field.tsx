import { useId } from 'react'
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

const labelClass = 'block text-xs font-black text-ink-700 uppercase tracking-widest mb-2'

interface FieldShellProps {
  /** id of the control, so the label is associated with it. */
  htmlFor?: string
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
}

/** Label + control + hint/error wrapper. Error takes precedence over hint. */
export function Field({ htmlFor, label, hint, error, children }: FieldShellProps) {
  return (
    <div>
      {label && <label htmlFor={htmlFor} className={labelClass}>{label}</label>}
      {children}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} className="text-[11px] text-red-600 mt-1">{error}</p>
      ) : hint ? (
        <p id={htmlFor ? `${htmlFor}-hint` : undefined} className="text-[11px] text-ink-700 mt-1">{hint}</p>
      ) : null}
    </div>
  )
}

type FieldExtras = { label?: ReactNode; hint?: ReactNode; error?: ReactNode }

/** The control's id (caller's, else generated) and the a11y attributes derived from error/hint. */
function useControlA11y(
  id: string | undefined,
  error: ReactNode,
  hint: ReactNode,
  callerDescribedBy?: string,
  callerInvalid?: boolean | 'true' | 'false' | 'grammar' | 'spelling',
) {
  const generated = useId()
  const controlId = id ?? generated
  return {
    controlId,
    attrs: {
      id: controlId,
      'aria-invalid': error ? (true as const) : callerInvalid,
      'aria-describedby':
        [callerDescribedBy, error ? `${controlId}-error` : hint ? `${controlId}-hint` : undefined]
          .filter(Boolean)
          .join(' ') || undefined,
    },
  }
}

export function Input({
  label,
  hint,
  error,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & FieldExtras) {
  const { controlId, attrs } = useControlA11y(rest.id, error, hint, rest['aria-describedby'], rest['aria-invalid'])
  return (
    <Field htmlFor={controlId} label={label} hint={hint} error={error}>
      <input className={cn(fieldClass, !!error && 'border-red-300', className)} {...rest} {...attrs} />
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
  const { controlId, attrs } = useControlA11y(rest.id, error, hint, rest['aria-describedby'], rest['aria-invalid'])
  return (
    <Field htmlFor={controlId} label={label} hint={hint} error={error}>
      <textarea
        rows={rows}
        className={cn(fieldClass, 'resize-none', !!error && 'border-red-300', className)}
        {...rest}
        {...attrs}
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
  const { controlId, attrs } = useControlA11y(rest.id, error, hint, rest['aria-describedby'], rest['aria-invalid'])
  return (
    <Field htmlFor={controlId} label={label} hint={hint} error={error}>
      <select className={cn(fieldClass, !!error && 'border-red-300', className)} {...rest} {...attrs}>
        {children}
      </select>
    </Field>
  )
}
