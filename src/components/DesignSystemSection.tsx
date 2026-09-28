import { useEffect, useState } from 'react'
import { draftStamp } from '../../shared/designSystem'
import { navigate } from '../App'
import { api, errorMessage, type DesignSystemRow } from '../lib/api'
import { useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { Swatches } from './Swatches'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ListHint, ListMeta, ListRow, ListSection, ListTitle } from './ui/list'

const errorText = 'px-4 pb-2 text-[12px] text-accent-ink'
const selectClass = 'h-7 w-full rounded-[6px] border border-line bg-surface px-2 text-[12px] text-ink'

/** The Design system section of the Design tab. On a system's draft canvas:
 *  its publish state and Publish. On a canvas that uses one: which version,
 *  pin or follow, stop. Otherwise: pick one of this workspace's systems, or
 *  make one from this canvas. */
export function DesignSystemSection({ canvasId }: { canvasId: string }) {
  const link = useStore((s) => s.system)
  const source = useStore((s) => s.systemSource)
  const canvas = useStore((s) => s.canvas)
  const [rows, setRows] = useState<DesignSystemRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)

  /* the draft's own row (canPublish, canvas count), or the systems this canvas may use */
  useEffect(() => {
    let live = true
    api
      .listDesignSystems(source ? undefined : canvasId)
      .then((list) => live && setRows(list))
      .catch(() => {}) // the section still works for the linked system without the list
    return () => {
      live = false
    }
  }, [canvasId, source, link?.version])

  const run = (p: Promise<unknown>, what: string) => {
    setBusy(true)
    setError(null)
    p.catch((e) => setError(errorMessage(e, what))).finally(() => setBusy(false))
  }
  const use = (systemId: string | null, pin: number | null = null) =>
    run(api.useDesignSystem(canvasId, systemId, pin), 'could not change the design system')

  if (source) {
    const row = rows.find((s) => s.id === source.id)
    const changed = !!canvas && draftStamp(canvas) !== source.publishedStamp
    const n = row?.canvasCount ?? 0
    return (
      <>
        <ListSection>
          <span>Design system draft</span>
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
        <ListRow onClick={() => navigate(`/s/${source.id}`)} title="Open the design system’s page">
          <ListTitle>{source.name}</ListTitle>
          <ListMeta>
            {source.publishedVersion
              ? `v${source.publishedVersion} · published ${timeAgo(source.publishedAt ?? source.updatedAt)}`
              : 'never published'}
            {row ? ` · ${n} canvas${n === 1 ? '' : 'es'}` : ''}
          </ListMeta>
        </ListRow>
        <ListHint>
          This canvas is the system’s draft; its frames are specimens. Theme, components and rules below reach the
          canvases using it when you publish.
          {changed && source.publishedVersion > 0 ? ' The draft has unpublished changes.' : ''}
        </ListHint>
        {error && <p className={errorText}>{error}</p>}
      </>
    )
  }

  if (link) {
    const s = link.system
    return (
      <>
        <ListSection>
          <span>Design system</span>
        </ListSection>
        <ListRow className="gap-1.5" onClick={() => navigate(`/s/${s.id}`)} title="Open the design system’s page">
          <Swatches colors={rows.find((r) => r.id === s.id)?.swatches ?? []} className="h-2" />
          <ListTitle>{s.name}</ListTitle>
          <ListMeta>
            v{link.version} · {link.pinned ? `pinned (latest v${s.publishedVersion})` : 'follows the latest version'}
          </ListMeta>
        </ListRow>
        <span className="flex gap-1.5 border-b border-line-soft px-4 py-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => use(s.id, link.pinned ? null : link.version)}
          >
            {link.pinned ? 'Follow latest' : `Pin v${link.version}`}
          </Button>
          <Button size="sm" variant="bare" disabled={busy} onClick={() => setConfirmStop(true)}>
            Stop using
          </Button>
        </span>
        <ListHint>
          Items marked “{s.name}” come from the system. Override one to change it on this canvas only.
        </ListHint>
        {error && <p className={errorText}>{error}</p>}
        <ConfirmDialog
          open={confirmStop}
          onOpenChange={setConfirmStop}
          title={`Stop using “${s.name}”?`}
          description="Its tokens, components and rules stay on this canvas as its own, so every frame looks the same. Later publishes no longer reach it."
          confirmLabel="Stop using"
          onConfirm={() => use(null)}
        />
      </>
    )
  }

  const where = canvas?.workspaceId ? 'this workspace' : 'your personal space'
  return (
    <>
      <ListSection>
        <span>Design system</span>
        {naming === null && (
          <Button
            variant="bare"
            size="sm"
            className="flex-none text-[11.5px]"
            title="Make a design system from this canvas’s theme, components and rules"
            onClick={() => setNaming('')}
          >
            Make one
          </Button>
        )}
      </ListSection>
      {naming !== null ? (
        <>
          <form
            className="flex gap-1.5 px-4 py-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!naming.trim()) return
              run(
                api.createDesignSystem({ name: naming, canvasId }).then(() => setNaming(null)),
                'could not create the design system',
              )
            }}
          >
            <Input autoFocus placeholder="System name" value={naming} onChange={(e) => setNaming(e.target.value)} />
            <Button size="sm" variant="solid" type="submit" disabled={busy || !naming.trim()}>
              Create
            </Button>
          </form>
          <ListHint>
            This canvas’s theme, components and rules move into a new system for {where}, published as v1. The canvas
            uses it and looks the same.
          </ListHint>
        </>
      ) : rows.length ? (
        <div className="border-b border-line-soft px-4 py-2">
          <select
            className={selectClass}
            value=""
            disabled={busy}
            aria-label="Use a design system"
            onChange={(e) => e.target.value && use(e.target.value)}
          >
            <option value="">Use a design system…</option>
            {rows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · v{s.publishedVersion}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <ListHint>No published design system in {where} yet. Make one from this canvas to share its design.</ListHint>
      )}
      {error && <p className={errorText}>{error}</p>}
    </>
  )
}
