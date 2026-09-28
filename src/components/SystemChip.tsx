import { navigate } from '../App'
import { useStore } from '../lib/store'
import { Button } from './ui/button'
import { PaletteIcon } from './ui/icons'
import { Tooltip } from './ui/tooltip'

const chip = 'h-7 max-w-[200px] gap-1.5 rounded-[7px] px-2 text-[12px] font-medium text-ink-soft hover:text-ink'

/** In the canvas top bar: the design system this canvas uses (opens the Design
 *  tab), or the one it is the draft of (opens the system's page). */
export function SystemChip({ onOpenDesign }: { onOpenDesign: () => void }) {
  const link = useStore((s) => s.system)
  const source = useStore((s) => s.systemSource)
  if (source)
    return (
      <Tooltip label="This canvas is a design system’s draft — open the system" side="bottom">
        <Button variant="ghost" className={chip} onClick={() => navigate(`/s/${source.id}`)}>
          <PaletteIcon className="size-[13px] flex-none" />
          <span className="truncate">{source.name}</span>
          <span className="flex-none text-ink-faint">draft</span>
        </Button>
      </Tooltip>
    )
  if (!link) return null
  return (
    <Tooltip label={`Uses the design system “${link.system.name}”`} side="bottom">
      <Button variant="ghost" className={chip} onClick={onOpenDesign}>
        <PaletteIcon className="size-[13px] flex-none" />
        <span className="truncate">{link.system.name}</span>
        <span className="flex-none font-mono text-[11px] text-ink-faint">v{link.version}</span>
      </Button>
    </Tooltip>
  )
}
