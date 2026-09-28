import { cn } from '@/lib/utils'

/** A design system's colours as one striped bar (the server sends plain colour values only). */
export function Swatches({ colors, className }: { colors: string[]; className?: string }) {
  return (
    <span aria-hidden className={cn('flex overflow-hidden rounded-[5px] border border-line', className)}>
      {colors.length ? (
        colors.map((c, i) => <span key={i} className="flex-1" style={{ background: c }} />)
      ) : (
        <span className="flex-1 bg-paper-deep" />
      )}
    </span>
  )
}
