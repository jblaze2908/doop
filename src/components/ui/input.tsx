import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* text-base below md is deliberate: iOS zooms the viewport when a focused
   field is under 16px, and that zoom is what makes a mobile form feel broken.
   The design size comes back at md, where no such thing happens. */
export const fieldVariants = cva(
  'w-full min-w-0 text-base text-ink transition-[border-color,box-shadow] outline-none placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60',
  {
    variants: {
      variant: {
        default:
          'rounded-md border border-line bg-surface px-3 focus:border-ink focus:ring-[3px] focus:ring-ink/[0.07] md:text-[13.5px]',
        /* ids, sizes, coordinates — the inspector's numeric fields */
        mono: 'rounded-lg border border-line bg-surface px-[9px] font-mono focus:border-ink md:text-[13px]',
        /* lives inside another bordered shell (search rows, the prompt bar) */
        bare: 'border-0 bg-transparent p-0 focus:ring-0 md:text-sm',
        /* an editable heading: invisible until you hover or focus it */
        title:
          'rounded-lg border border-transparent bg-transparent px-2 font-display font-semibold hover:border-line focus:border-ink focus:bg-white md:text-[15px]',
      },
      inputSize: {
        sm: 'h-8 py-1',
        md: 'h-9 py-1.5',
        lg: 'h-11 py-2.5',
        auto: '',
      },
    },
    defaultVariants: { variant: 'default', inputSize: 'md' },
  },
)

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'> & VariantProps<typeof fieldVariants>>(
  function Input({ className, variant, inputSize, type, ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(fieldVariants({ variant, inputSize, className }))}
        {...props}
      />
    )
  },
)

/** The bordered "value ▾" select. A native select underneath keeps the
 *  keyboard; the visible part is styled. */
function Sel({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <span className={cn('relative inline-flex min-w-0', className)}>
      <select
        className={cn(
          fieldVariants({ variant: 'default', inputSize: 'sm' }),
          'h-[34px] w-full cursor-pointer appearance-none truncate rounded-lg pl-[11px] pr-8 text-[13.5px] font-semibold tracking-[-0.01em]',
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  )
}

export { Input, Sel }
