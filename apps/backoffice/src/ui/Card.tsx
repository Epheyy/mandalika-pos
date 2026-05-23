import type { HTMLAttributes } from 'react'
import { cn } from './cn'

/** Standard surface: white card on the warm canvas, warm hairline border. */
export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('bg-white rounded-2xl border border-gray-100', className)} {...rest}>
      {children}
    </div>
  )
}
