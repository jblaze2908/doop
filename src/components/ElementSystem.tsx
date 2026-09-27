import { useState, type ReactNode } from 'react'
import type { ThemeToken } from '../../shared/theme'
import type { ComponentDef } from '../../shared/components'
import { tokenRef } from '../lib/designTokens'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { PropertyRow, PropertySection, SelectField, TextField } from './ui/property-field'

/* Design-system controls for the element panel: token pickers that write
   var(--…), the class list, and linked-component props. */

const chipCls =
  'flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-brand/40 bg-brand/[0.06] px-1.5 font-mono text-[11px] text-ink'

function Swatch({ value }: { value: string }) {
  return (
    <span
      className="relative size-3 flex-none overflow-hidden rounded-[3px] border border-line"
      style={{ background: value }}
    />
  )
}

/** The ◆ button next to a field: lists the theme tokens that fit it. */
export function TokenMenu({ tokens, onPick }: { tokens: ThemeToken[]; onPick: (ref: string) => void }) {
  if (!tokens.length) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Use a theme token"
        className="grid h-6 w-6 flex-none place-items-center rounded-md border border-line text-[10px] text-ink-soft hover:border-ink hover:text-ink"
      >
        ◆
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[320px] w-[240px] overflow-y-auto">
        {tokens.map((t) => (
          <DropdownMenuItem key={t.name} className="py-[7px] text-[12px]" onSelect={() => onPick(`var(${t.name})`)}>
            {t.type === 'color' ? <Swatch value={t.value} /> : null}
            <span className="min-w-0 flex-1 truncate font-mono">{t.name}</span>
            <span className="max-w-[80px] truncate font-mono text-[10.5px] text-ink-faint">{t.value}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A token-aware slot: a linked token shows as a chip (detach keeps the
 *  current literal), anything else shows the plain field plus the token menu. */
export function TokenValue({
  inline,
  tokens,
  onPick,
  onDetach,
  children,
}: {
  inline: string | undefined
  tokens: ThemeToken[]
  onPick: (ref: string) => void
  onDetach: () => void
  children: ReactNode
}) {
  const ref = tokenRef(inline)
  if (ref) {
    const token = tokens.find((t) => t.name === ref)
    return (
      <span className={chipCls} title={token ? `${ref}: ${token.value}` : `${ref} (not in the theme)`}>
        {token?.type === 'color' ? <Swatch value={token.value} /> : <span className="text-brand">◆</span>}
        <span className="min-w-0 flex-1 truncate">{ref}</span>
        <button
          type="button"
          aria-label={`Detach ${ref}`}
          className="flex-none text-ink-faint hover:text-ink"
          onClick={onDetach}
        >
          ×
        </button>
      </span>
    )
  }
  return (
    <>
      {children}
      <TokenMenu tokens={tokens} onPick={onPick} />
    </>
  )
}

/** The element's class list as removable chips, plus an input suggesting the
 *  classes the theme defines. */
export function ClassEditor({
  classes,
  suggestions,
  onChange,
}: {
  classes: string[]
  suggestions: string[]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  function add() {
    const names = draft.split(/\s+/).filter((c) => /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(c) && !classes.includes(c))
    setDraft('')
    if (names.length) onChange([...classes, ...names])
  }
  return (
    <PropertySection title="Classes">
      <div className="flex flex-wrap gap-1">
        {classes.map((c) => (
          <span
            key={c}
            className={cn(
              'flex h-6 items-center gap-1 rounded-md border border-line bg-paper px-1.5 font-mono text-[11px] text-ink',
              suggestions.includes(c) && 'border-brand/40',
            )}
          >
            .{c}
            <button
              type="button"
              aria-label={`Remove class ${c}`}
              className="text-ink-faint hover:text-ink"
              onClick={() => onChange(classes.filter((x) => x !== c))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          list="draft-theme-classes"
          aria-label="Add class"
          placeholder={classes.length ? '+ class' : 'Add a class'}
          className="h-6 min-w-[88px] flex-1 rounded-md border border-dashed border-line bg-transparent px-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-ink"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <datalist id="draft-theme-classes">
          {suggestions
            .filter((c) => !classes.includes(c))
            .map((c) => (
              <option key={c} value={c} />
            ))}
        </datalist>
      </div>
    </PropertySection>
  )
}

/** A selected instance: its props are attributes, edited in place. */
export function ComponentProps({
  def,
  attributes,
  onChange,
}: {
  def: ComponentDef
  attributes: Record<string, string>
  onChange: (name: string, value: string | null) => void
}) {
  return (
    <PropertySection title={`Component · <${def.name}>`}>
      {def.props.length === 0 && (
        <p className="text-[11px] text-ink-faint">No props — edit its content in the frame.</p>
      )}
      {def.props.map((p) => (
        <PropertyRow key={p.name} label={p.name}>
          <TextField
            value={attributes[p.name] ?? ''}
            placeholder={p.default ?? ''}
            onCommit={(v) => onChange(p.name, v.trim() === '' ? null : v)}
          />
        </PropertyRow>
      ))}
      <p className="mt-1.5 text-[10.5px] leading-[1.4] text-ink-faint">
        Its look comes from the definition in Memory → Components; editing it there updates every instance.
      </p>
    </PropertySection>
  )
}

/** Replace a plain element with an instance, keeping its content as slot content. */
export function SwapToComponent({
  components,
  onSwap,
}: {
  components: ComponentDef[]
  onSwap: (name: string) => void
}) {
  if (!components.length) return null
  return (
    <PropertySection title="Component">
      <PropertyRow label="Swap to">
        <SelectField
          value=""
          options={[
            { value: '', label: 'Choose a component…' },
            ...components.map((c) => ({ value: c.name, label: `<${c.name}>` })),
          ]}
          onChange={(v) => v && onSwap(v)}
        />
      </PropertyRow>
    </PropertySection>
  )
}
