/** The Disc-D: a half-disc with a dot resting under its stem, reading as
 *  Draft's initial — the frame and the cursor beside it. (Identity round 10.)
 *
 *  The tile is part of the mark, so every call site gets the same lockup
 *  without having to supply its own background. */
export function Logo({ className = 'size-[30px]' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 200 200" aria-hidden>
      <rect width="200" height="200" rx="48" fill="#111110" />
      <g fill="#fdfdfc" transform="translate(14,0)">
        <path d="M78 36 A 64 64 0 0 1 78 164 Z" />
        <circle cx="50" cy="146" r="19" />
      </g>
    </svg>
  )
}

/** The bare Disc-D, no tile: the glyph that stands for a Draft agent inline
 *  next to text (presence chips, cursor pills, activity rows). Inherits the
 *  text colour unless a fill is given. The viewBox crops to the mark itself
 *  so it sits on the text baseline like a letter. */
export function DraftMark({
  size = 13,
  color,
  className = 'mr-px inline-block align-[-2px]',
}: {
  size?: number
  color?: string
  className?: string
}) {
  return (
    <svg
      className={className}
      /* inline so Button's descendant-svg rule (16px unless a size- class) cannot override it */
      style={{ width: Math.round((size * 118) / 137), height: size }}
      viewBox="42 32 118 137"
      fill={color ?? 'currentColor'}
      aria-hidden
    >
      <g transform="translate(14,0)">
        <path d="M78 36 A 64 64 0 0 1 78 164 Z" />
        <circle cx="50" cy="146" r="19" />
      </g>
    </svg>
  )
}
