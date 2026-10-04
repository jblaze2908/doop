import { useEffect, useMemo, useState } from 'react'
import type { DesignFinding, Frame } from '../../shared/types'
import { loadCheckRules, runDesignCheck, type CheckRule } from '../lib/designCheck'
import { useStore } from '../lib/store'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { XIcon } from './ui/icons'

const CHIP =
  'inline-flex cursor-pointer items-center gap-1 rounded-full border border-line bg-surface px-[7px] py-0.5 text-[10px] font-semibold text-ink-soft animate-[chip-in_0.25s_ease] hover:text-ink'
const SELECTORS_SHOWN = 4

/** The frame label's design-check chip: finding count, or the check's progress. */
export function DesignCheckChip({ frame }: { frame: Frame }) {
  const audit = useStore((s) => s.audits[frame.id])
  const check = useStore((s) => s.checks[frame.id])
  const open = useStore((s) => s.openCheck === frame.id)
  const setOpen = useStore((s) => s.setOpenCheck)
  if (!audit && !check) return null
  const stale = !!audit && audit.frameUpdatedAt !== frame.updatedAt
  const count = audit ? audit.findings.length + (audit.truncated ?? 0) : 0
  const label =
    check === 'running'
      ? 'Checking…'
      : check === 'failed' && !audit
        ? 'Check failed'
        : count === 0
          ? '✓ No issues'
          : `${count} issue${count === 1 ? '' : 's'}`
  return (
    <button
      type="button"
      className={cn(CHIP, open && 'border-ink text-ink', stale && check !== 'running' && 'opacity-55')}
      title={stale ? 'Design check — the frame changed since this check' : 'Design check'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => setOpen(open ? null : frame.id)}
    >
      {label}
    </button>
  )
}

/** Findings grouped by rule, anchored under the label chip and counter-scaled like its label. */
export function DesignCheckPopover({ frame }: { frame: Frame }) {
  const open = useStore((s) => s.openCheck === frame.id)
  if (!open) return null
  return <CheckPopover frame={frame} />
}

function CheckPopover({ frame }: { frame: Frame }) {
  const audit = useStore((s) => s.audits[frame.id])
  const check = useStore((s) => s.checks[frame.id])
  const setOpen = useStore((s) => s.setOpenCheck)
  const [rules, setRules] = useState<Map<string, CheckRule> | null>(null)
  useEffect(() => {
    let live = true
    loadCheckRules()
      .then((r) => live && setRules(r))
      .catch(console.error)
    return () => {
      live = false
    }
  }, [])
  const groups = useMemo(() => {
    const byRule = new Map<string, DesignFinding[]>()
    for (const f of audit?.findings ?? []) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f])
    /* AI tells first: they are what this check exists to catch */
    return [...byRule].sort(([, a], [, b]) =>
      a[0]!.category === b[0]!.category ? 0 : a[0]!.category === 'slop' ? -1 : 1,
    )
  }, [audit])
  const stale = !!audit && audit.frameUpdatedAt !== frame.updatedAt
  const count = audit ? audit.findings.length + (audit.truncated ?? 0) : 0

  function pick(selector: string) {
    const s = useStore.getState()
    s.select(frame.id)
    s.pickElement({ frameId: frame.id, selector })
  }

  return (
    <div
      className="pointer-events-auto absolute top-0 left-0 z-[8] w-[320px] origin-top-left cursor-default rounded-[10px] border border-line bg-surface text-left shadow-pop animate-[chip-in_0.18s_ease] [transform:scale(min(calc(1/var(--zoom,1)),2.4))]"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-line-soft px-3 py-2">
        <div className="min-w-0 text-[12px] font-semibold text-ink">
          Design check
          {audit && (
            <span className="ml-1.5 font-normal text-ink-faint">
              {count === 0 ? 'no issues' : `${count} issue${count === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={check === 'running'}
            onClick={() => void runDesignCheck(frame.id)}
          >
            {check === 'running' ? 'Checking…' : audit ? 'Re-check' : 'Check'}
          </Button>
          <Button
            variant="bare"
            size="icon-sm"
            aria-label="Close design check"
            className="text-ink-faint hover:bg-paper-deep hover:text-ink"
            onClick={() => setOpen(null)}
          >
            <XIcon width={12} height={12} />
          </Button>
        </div>
      </div>
      {stale && (
        <div className="border-b border-line-soft px-3 py-1.5 text-[11px] text-ink-soft">
          The frame changed since this check.
        </div>
      )}
      {check === 'failed' && (
        <div className="border-b border-line-soft px-3 py-1.5 text-[11px] text-accent-ink">
          The check could not run. Try again.
        </div>
      )}
      <div data-stage-scroll="" className="max-h-[360px] overflow-y-auto px-3 py-1">
        {audit && groups.length === 0 && (
          <p className="py-2 text-[12px] text-ink-soft">No anti-patterns found in this frame.</p>
        )}
        {groups.map(([id, findings]) => {
          const rule = rules?.get(id)
          const first = findings[0]!
          return (
            <div key={id} className="border-b border-line-soft py-2 last:border-b-0">
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <b className="font-semibold text-ink">{rule?.name ?? id}</b>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
                  {first.category === 'slop' ? 'AI tell' : 'Quality'}
                  {findings.length > 1 && ` ×${findings.length}`}
                </span>
              </div>
              {rule && <p className="mt-0.5 text-[11px] leading-[1.4] text-ink-soft">{rule.description}</p>}
              <ul className="mt-1 space-y-0.5">
                {findings.slice(0, SELECTORS_SHOWN).map((f, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="w-full truncate rounded-sm text-left text-[11px] text-ink-soft hover:bg-paper-deep hover:text-ink"
                      title={`Select ${f.selector}`}
                      onClick={() => pick(f.selector)}
                    >
                      <span className="font-mono text-ink">{f.selector}</span>
                      {f.detail && <span> — {f.detail}</span>}
                    </button>
                  </li>
                ))}
                {findings.length > SELECTORS_SHOWN && (
                  <li className="text-[11px] text-ink-faint">+{findings.length - SELECTORS_SHOWN} more</li>
                )}
              </ul>
            </div>
          )
        })}
        {audit?.truncated ? (
          <p className="py-2 text-[11px] text-ink-faint">{audit.truncated} more findings not shown.</p>
        ) : null}
      </div>
      <div className="border-t border-line-soft px-3 py-1.5 text-[10px] text-ink-faint">
        Rules from{' '}
        <a className="underline hover:text-ink" href="https://impeccable.style" target="_blank" rel="noreferrer">
          Impeccable
        </a>
      </div>
    </div>
  )
}
