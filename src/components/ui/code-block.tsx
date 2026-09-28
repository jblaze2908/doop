import * as React from 'react'

import { cn } from '@/lib/utils'

function CodeBlock({ text, className, ...props }: Omit<React.ComponentProps<'div'>, 'children'> & { text: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div
      data-slot="code-block"
      className={cn(
        'relative rounded-[10px] bg-[#17171b] py-[13px] pl-3.5 pr-11 font-mono text-xs leading-[1.55] whitespace-pre-wrap break-all text-[#e9e9ee] dark:ring-1 dark:ring-line',
        className,
      )}
      {...props}
    >
      {text}
      <button
        type="button"
        className="absolute right-2 top-2 rounded-[6px] bg-white/[0.08] px-2 py-1 text-[11px] text-[#e9e9ee] transition-colors hover:bg-white/[0.18]"
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }, console.error)
        }}
      >
        {copied ? '✓' : 'copy'}
      </button>
    </div>
  )
}

export { CodeBlock }
