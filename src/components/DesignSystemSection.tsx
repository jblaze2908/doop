import { useEffect, useState } from 'react'
import { draftStamp } from '../../shared/designSystem'
import { api, errorMessage, type DesignSystemRow } from '../lib/api'
import { useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ListHint, ListMeta, ListRow, ListSection, ListTitle } from './ui/list'

const errorText = 'px-4 pb-2 text-[12px] text-accent-ink'
const selectClass = 'h-7 w-full rounded-[6px] border border-line bg-surface px-2 text-[12px] text-ink'

/** The Design system section of the Memory panel: which shared system this
 *  canvas renders from (switch, pin, stop), or — on a system's source canvas —
 *  its publish state and the Publish button. */
export function DesignSystemSection({ canvasId }: { canvasId: string }) {
  const link = useStore((s) => s.system)
  const source = useStore((s) => s.systemSource)
  const canvas = useStore((s) => s.canvas)
  const [systems, setSystems] = useState<DesignSystemRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .listDesignSystems()
      .then((rows) => live && setSystems(rows))
      .catch(() => {}) // the section still works for the linked system without the list
    return () => {
      live = false
    }
  }, [canvasId, link?.version, source?.publishedVersion])

  const run = (p: Promise<unknown>, what: string) => {
    setBusy(true)
    setError(null)
    p.catch((e) => setError(errorMessage(e, what))).finally(() => setBusy(false))
  }
  const use = (systemId: string | null, pin: number | null = null) =>
    run(api.useDesignSystem(canvasId, systemId, pin), 'could not change the design system')

  if (source) {
    const row = systems.find((s) => s.id === source.id)
    const changed = !!canvas && draftStamp(canvas) !== source.publishedStamp
    return (
      <>
        <ListSection>
          <span>Design system</span>
          {row?.canPublish && (
            <Button
              variant="solid"
              size="sm"
              className="flex-none text-[11.5px] font-bold"
              disabled={busy || (!changed && source.publishedVersion > 0)}
              onClick={() => run(api.publishDesignSystem(source.id), 'publish failed')}
            >
              Publish
            </Button>
          )}
        </ListSection>
        <ListRow>
          <ListTitle>{source.name}</ListTitle>
          <ListMeta>
            {source.publishedVersion
              ? `v${source.publishedVersion} · published ${timeAgo(source.publishedAt ?? source.updatedAt)}`
              : 'never published'}
            {row ? ` · ${row.canvasCount} canvas${row.canvasCount === 1 ? '' : 'es'}` : ''}
          </ListMeta>
        </ListRow>
        <ListHint>
          This canvas is the system’s draft: its theme, components and rules reach other canvases when published.
          {changed && source.publishedVersion > 0 ? ' The draft has unpublished changes.' : ''}
        </ListHint>
        {error && <p className={errorText}>{error}</p>}
      </>
    )
  }

  const usable = systems.filter((s) => s.publishedVersion > 0)
  return (
    <>
      <ListSection>
        <span>Design system</span>
        {!link && naming === null && (
          <Button variant="bare" size="sm" className="flex-none text-[11.5px]" onClick={() => setNaming('')}>
            Make one
          </Button>
        )}
      </ListSection>
      {link ? (
        <ListRow>
          <ListTitle>{link.system.name}</ListTitle>
          <ListMeta>
            v{link.version} ·{' '}
            {link.pinned ? `pinned (latest v${link.system.publishedVersion})` : 'follows the latest version'}
          </ListMeta>
          <span className="mt-1 flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => use(link.system.id, link.pinned ? null : link.version)}
            >
              {link.pinned ? 'Follow latest' : `Pin v${link.version}`}
            </Button>
            <Button size="sm" variant="bare" disabled={busy} onClick={() => use(null)}>
              Stop using
            </Button>
          </span>
        </ListRow>
      ) : naming !== null ? (
        <form
          className="flex gap-1.5 px-4 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!naming.trim()) return
            run(
              api.createDesignSystem(canvasId, naming).then(() => setNaming(null)),
              'could not create the design system',
            )
          }}
        >
          <Input autoFocus placeholder="System name" value={naming} onChange={(e) => setNaming(e.target.value)} />
          <Button size="sm" variant="solid" type="submit" disabled={busy || !naming.trim()}>
            Create
          </Button>
        </form>
      ) : usable.length ? (
        <div className="px-4 py-2">
          <select
            className={selectClass}
            value=""
            disabled={busy}
            aria-label="Use a design system"
            onChange={(e) => e.target.value && use(e.target.value)}
          >
            <option value="">Use a design system…</option>
            {usable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · v{s.publishedVersion}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {link ? (
        <ListHint>
          Theme, components and rules below are this canvas’s own: they override the system here only.
        </ListHint>
      ) : naming !== null ? (
        <ListHint>This canvas’s theme, components and rules become the system’s draft. Publish to share it.</ListHint>
      ) : !usable.length ? (
        <ListHint>Share one theme, component set and rules across canvases. Make this canvas the first.</ListHint>
      ) : null}
      {error && <p className={errorText}>{error}</p>}
    </>
  )
}
