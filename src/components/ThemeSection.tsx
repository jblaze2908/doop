import { useState } from 'react'
import { MAX_THEME_CSS_CHARS, type ThemeToken } from '../../shared/theme'
import { originOf, type DesignOrigin } from '../../shared/designSystem'
import { useStore } from '../lib/store'
import { useEffectiveTheme } from '../lib/theme'
import { api, errorMessage } from '../lib/api'
import { throttle } from '../lib/throttle'
import { timeAgo } from '../lib/time'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { ListHint, ListItem, ListMeta, ListRow, ListSection, ListSummary, ListTitle } from './ui/list'
import { Modal, ModalActions, ModalSpacer, ModalTitle } from './ui/modal'
import { cn } from '@/lib/utils'

const errorText = 'px-4 pb-2 text-[12px] text-accent-ink'
const HEX6 = /^#[0-9a-f]{6}$/i

type OnError = (message: string | null) => void

function saveTheme(canvasId: string, patch: Parameters<typeof api.setTheme>[1], onError: OnError) {
  onError(null)
  api.setTheme(canvasId, patch).catch((e) => onError(errorMessage(e, 'theme update failed')))
}

/** Split "Geist, Fraunces:ital,wght@0,400;1,700" into families: commas also
 *  separate the axes and the values inside one css2 spec. */
function splitFonts(input: string): string[] {
  const out: string[] = []
  for (const raw of input.split(',')) {
    const part = raw.trim()
    const prev = out[out.length - 1]
    const inAxes = prev !== undefined && prev.includes(':') && !prev.includes('@')
    const inValues = prev !== undefined && prev.includes('@') && !/^[A-Za-z]/.test(part)
    if (prev !== undefined && (inAxes || inValues)) out[out.length - 1] = `${prev},${part}`
    else if (part) out.push(part)
  }
  return out
}

/** The Theme section of the Design tab: tokens every frame inherits (edit a
 *  value inline, or pick a colour), the Google Fonts list, and the shared CSS.
 *  On a canvas that uses a design system its tokens show read-only until
 *  overridden here; its fonts and CSS come first and the canvas's add to them. */
export function ThemeSection({ canvasId }: { canvasId: string }) {
  const theme = useStore((s) => s.canvas?.theme)
  const system = useStore((s) => s.system?.snapshot.theme)
  const systemName = useStore((s) => s.system?.system.name)
  const effective = useEffectiveTheme()
  const [cssOpen, setCssOpen] = useState(false)
  const [systemCssOpen, setSystemCssOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const write = (patch: Parameters<typeof api.setTheme>[1]) => saveTheme(canvasId, patch, setError)

  const tokens = (system ? effective?.tokens : theme?.tokens) ?? []
  return (
    <>
      <ListSection>
        <span>Theme</span>
        <Button
          variant="solid"
          size="sm"
          className="flex-none text-[11.5px] font-bold"
          onClick={() => setCssOpen(true)}
        >
          CSS
        </Button>
      </ListSection>
      {!tokens.length && !effective?.css && (
        <ListHint>
          Tokens, fonts and CSS every frame on this canvas inherits. Change one and every frame follows.
        </ListHint>
      )}
      {tokens.map((t) => (
        <TokenRow
          key={t.name}
          canvasId={canvasId}
          token={t}
          origin={system ? originOf(t.name, system.tokens, theme?.tokens) : 'local'}
          systemName={systemName}
          onError={setError}
        />
      ))}
      <AddToken onAdd={(name, value) => write({ tokens: [{ name, value }] })} />
      <FontsRow
        fonts={theme?.fonts ?? []}
        unresolved={theme?.unresolvedFonts ?? []}
        inherited={system?.fonts.length ? `${systemName}: ${system.fonts.join(', ')}` : undefined}
        onCommit={(fonts) => write({ fonts })}
      />
      {system?.css ? (
        <ListRow onClick={() => setSystemCssOpen(true)}>
          <ListTitle>{systemName} CSS</ListTitle>
          <ListSummary className="font-mono">{system.css.split('\n')[0]}</ListSummary>
          <ListMeta>
            {(system.css.length / 1000).toFixed(1)} KB · read-only here · this canvas’s CSS comes after it
          </ListMeta>
        </ListRow>
      ) : null}
      {theme?.css ? (
        <ListRow onClick={() => setCssOpen(true)}>
          <ListTitle>{system ? 'Canvas CSS' : 'Shared CSS'}</ListTitle>
          <ListSummary className="font-mono">{theme.css.split('\n')[0]}</ListSummary>
          <ListMeta>
            {(theme.css.length / 1000).toFixed(1)} KB · {theme.updatedBy} · {timeAgo(theme.updatedAt)}
          </ListMeta>
        </ListRow>
      ) : null}
      {error && <p className={errorText}>{error}</p>}
      {cssOpen && <ThemeCssModal canvasId={canvasId} css={theme?.css ?? ''} onClose={() => setCssOpen(false)} />}
      {systemCssOpen && (
        <ThemeCssModal
          canvasId={canvasId}
          css={system?.css ?? ''}
          readOnlyFrom={systemName}
          onClose={() => setSystemCssOpen(false)}
        />
      )}
    </>
  )
}

function TokenRow({
  canvasId,
  token,
  origin,
  systemName,
  onError,
}: {
  canvasId: string
  token: ThemeToken
  origin: DesignOrigin
  systemName?: string
  onError: OnError
}) {
  const [draft, setDraft] = useState(token.value)
  /* a remote edit replaces the draft; reset during render, not in an effect */
  const [seen, setSeen] = useState(token.value)
  if (seen !== token.value) {
    setSeen(token.value)
    setDraft(token.value)
  }
  const onCommit = (value: string) => saveTheme(canvasId, { tokens: [{ name: token.name, value }] }, onError)
  /* a colour picker drag fires per pixel — one theme write per ~150ms; built
     once, since the row is keyed by token name */
  const [commitThrottled] = useState(() => throttle(onCommit, 150))

  function commit() {
    const value = draft.trim()
    if (value === token.value) return
    /* the server has no CSS parser; the browser does, and a bad colour would
       silently blank every var() that uses it */
    if (value && token.type === 'color' && !CSS.supports('color', value)) {
      onError(`“${value}” is not a CSS colour`)
      setDraft(token.value)
      return
    }
    onCommit(value) // empty deletes the token
  }

  const tip = [
    token.description,
    origin === 'system' ? `From ${systemName}` : origin === 'override' ? `Overrides ${systemName}` : undefined,
  ]
    .filter(Boolean)
    .join(' — ')
  if (origin === 'system')
    return (
      <ListItem className="flex-row items-center gap-2 py-[7px]" title={tip}>
        {token.type === 'color' && (
          <span className="size-5 flex-none rounded-[6px] border border-line" style={{ background: token.value }} />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-faint">{token.name}</span>
        <span className="max-w-[92px] flex-none truncate font-mono text-[11.5px] text-ink-soft">{token.value}</span>
        <Button
          variant="bare"
          size="sm"
          className="flex-none px-1.5 text-[11px]"
          aria-label={`Override ${token.name} on this canvas`}
          onClick={() => onCommit(token.value)}
        >
          Override
        </Button>
      </ListItem>
    )

  return (
    <ListItem className="flex-row items-center gap-2 py-[7px]" title={tip || undefined}>
      {token.type === 'color' && (
        <label
          className="relative size-5 flex-none cursor-pointer overflow-hidden rounded-[6px] border border-line"
          style={{ background: token.value }}
        >
          {HEX6.test(token.value) && (
            <input
              type="color"
              aria-label={`Pick ${token.name}`}
              className="absolute inset-0 cursor-pointer opacity-0"
              value={token.value}
              onChange={(e) => {
                setDraft(e.target.value)
                commitThrottled(e.target.value)
              }}
            />
          )}
        </label>
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-soft">{token.name}</span>
      <Input
        variant="mono"
        inputSize="sm"
        className={cn('flex-none md:text-[11.5px]', origin === 'override' ? 'w-[92px]' : 'w-[124px]')}
        aria-label={`${token.name} value`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(token.value)
            e.currentTarget.blur()
          }
        }}
      />
      {origin === 'override' && (
        <Button
          variant="bare"
          size="sm"
          className="flex-none px-1.5 text-[11px]"
          aria-label={`Reset ${token.name} to ${systemName}`}
          onClick={() => onCommit('')}
        >
          Reset
        </Button>
      )}
    </ListItem>
  )
}

function AddToken({ onAdd }: { onAdd: (name: string, value: string) => void }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const ready = name.trim() && value.trim()

  function add() {
    if (!ready) return
    onAdd(name.trim(), value.trim())
    setName('')
    setValue('')
  }

  return (
    <form
      className="flex items-center gap-2 border-b border-line-soft px-4 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        add()
      }}
    >
      <Input
        variant="mono"
        inputSize="sm"
        className="min-w-0 flex-1 md:text-[11.5px]"
        placeholder="--color-ink"
        aria-label="New token name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        variant="mono"
        inputSize="sm"
        className="w-[96px] flex-none md:text-[11.5px]"
        placeholder="#17171b"
        aria-label="New token value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" variant="ghost" size="sm" className="flex-none text-[11.5px]" disabled={!ready}>
        Add
      </Button>
    </form>
  )
}

function FontsRow({
  fonts,
  unresolved,
  inherited,
  onCommit,
}: {
  fonts: string[]
  unresolved: string[]
  /** the design system's fonts, which load first */
  inherited?: string
  onCommit: (fonts: string[]) => void
}) {
  const joined = fonts.join(', ')
  const [draft, setDraft] = useState(joined)
  const [seen, setSeen] = useState(joined)
  if (seen !== joined) {
    setSeen(joined)
    setDraft(joined)
  }

  function commit() {
    const next = splitFonts(draft)
    if (next.join(', ') !== joined) onCommit(next)
  }

  return (
    <ListItem className="py-2">
      <ListMeta>{inherited ? `Google Fonts · ${inherited}, plus` : 'Google Fonts'}</ListMeta>
      <Input
        inputSize="sm"
        className="md:text-[12px]"
        placeholder="Geist, Inter:wght@400;600"
        aria-label="Theme fonts"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      {unresolved.length > 0 && (
        <span className="text-[11px] text-accent-ink">Could not load {unresolved.join(', ')} from Google Fonts.</span>
      )}
    </ListItem>
  )
}

function ThemeCssModal({
  canvasId,
  css,
  readOnlyFrom,
  onClose,
}: {
  canvasId: string
  css: string
  /** the design system this CSS comes from: shown, not edited */
  readOnlyFrom?: string
  onClose: () => void
}) {
  const [draft, setDraft] = useState(css)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await api.setTheme(canvasId, { css: draft })
      onClose()
    } catch (e) {
      setError(errorMessage(e, 'save failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal size="xl" onClose={() => !busy && onClose()}>
      <>
        <ModalTitle>{readOnlyFrom ? `${readOnlyFrom} CSS` : 'Theme CSS'}</ModalTitle>
        <p className="mt-1.5 text-[11.5px] text-ink-faint">
          {readOnlyFrom
            ? `From the design system, ahead of this canvas’s CSS. Change it on the system’s draft.`
            : 'Injected into every frame ahead of its own styles. Use the tokens as var(--…); fonts go in the Fonts row.'}
        </p>
        <Textarea
          className="mt-3 min-h-[38dvh] resize-y rounded-[12px] bg-surface px-4 py-3.5 font-mono leading-[1.65] focus:ring-0 sm:min-h-[46vh] md:text-[12.5px]"
          autoFocus
          placeholder={'.btn {\n  background: var(--color-ink);\n}'}
          value={draft}
          maxLength={MAX_THEME_CSS_CHARS}
          disabled={busy}
          readOnly={!!readOnlyFrom}
          onChange={(e) => setDraft(e.target.value)}
        />
        {error && <p className="mt-2.5 text-[13px] text-accent-ink">{error}</p>}
        <ModalActions className="items-center">
          <span className="text-[11.5px] text-ink-faint">
            {draft.length.toLocaleString()} / {MAX_THEME_CSS_CHARS.toLocaleString()}
          </span>
          <ModalSpacer />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {readOnlyFrom ? 'Close' : 'Cancel'}
          </Button>
          {!readOnlyFrom && (
            <Button variant="primary" disabled={busy || draft === css} onClick={save}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          )}
        </ModalActions>
      </>
    </Modal>
  )
}
