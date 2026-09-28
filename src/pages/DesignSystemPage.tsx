import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceSummary } from '../../shared/types'
import { navigate } from '../App'
import { api, errorMessage, type DesignSystemDetail } from '../lib/api'
import { openCanvasTab } from '../lib/desktop'
import { useHomeFeed } from '../lib/homeFeed'
import { timeAgo } from '../lib/time'
import { AccountMenu, ConnectCard, IconBack, IconChevron } from '../components/DashShell'
import { Swatches } from '../components/Swatches'
import { ConfirmDialog } from '../components/ui/alert-dialog'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardDescription, CardHeader, CardRow, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Skeleton } from '../components/ui/skeleton'
import { Toast } from '../components/ui/toast'
import { Wordmark } from '../components/ui/wordmark'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashSidebar,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`

/** One design system: what its draft holds, its versions, the canvases using it,
 *  and its settings. The draft itself is a canvas, opened from here. */
export function DesignSystemPage({ systemId }: { systemId: string }) {
  const [ds, setDs] = useState<DesignSystemDetail | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const reload = useCallback(() => {
    api
      .getDesignSystem(systemId)
      .then(setDs)
      .catch(() => setMissing(true))
    api
      .listWorkspaces()
      .then((res) => setWorkspaces(res.workspaces))
      .catch(console.error)
  }, [systemId])

  useEffect(reload, [reload])
  /* publishes, renames and default changes by other people arrive as dashboard refreshes */
  useHomeFeed({ refresh: reload })

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
  }

  async function run(action: () => Promise<unknown>, fallback: string, done?: string): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    try {
      await action()
      if (done) showToast(done)
      reload()
      return true
    } catch (caught) {
      showToast(errorMessage(caught, fallback))
      return false
    } finally {
      setBusy(false)
    }
  }

  function open(id: string, name: string) {
    if (!openCanvasTab(id, name)) navigate(`/c/${id}`)
  }

  if (missing) {
    return (
      <DashLayout>
        <DashMain>
          <DashHeader>
            <span className="flex-1" />
            <AccountMenu />
          </DashHeader>
          <DashContent>
            <DashTitle>Design system not found</DashTitle>
            <DashSubtitle>It may have been deleted, or you no longer have access to its workspace.</DashSubtitle>
            <Button className="mt-5" onClick={() => navigate('/')}>
              Back to canvases
            </Button>
          </DashContent>
        </DashMain>
      </DashLayout>
    )
  }

  const ws = ds?.workspaceId ? workspaces.find((w) => w.id === ds.workspaceId) : undefined
  const scope = ds ? (ds.workspaceId ? (ws?.name ?? 'Workspace') : 'Personal') : '…'
  const latest = ds?.publishedVersion ?? 0
  const pending = !!ds && (latest === 0 || ds.draftChanged)

  return (
    <DashLayout>
      <DashSidebar>
        <Wordmark size="sm" className="px-2 pb-5 text-[17px]" />
        <Button
          variant="ghost"
          className="w-full justify-start gap-[9px] rounded-[9px] px-[10px] py-2 text-[13px] text-ink-soft hover:bg-paper hover:text-ink"
          onClick={() => navigate('/')}
        >
          <IconBack /> Back to canvases
        </Button>
        <div className="min-h-6 flex-1" />
        <ConnectCard />
      </DashSidebar>

      <DashMain>
        <DashHeader>
          <nav className="flex min-w-0 items-center gap-2 text-[13px] text-ink-faint" aria-label="Breadcrumb">
            <Button
              variant="link"
              size="sm"
              className="px-0 py-0 text-[13px] font-normal text-ink-faint hover:text-ink"
              onClick={() => navigate('/')}
            >
              Home
            </Button>
            <IconChevron />
            <span className="truncate">{scope}</span>
            <IconChevron />
            <b className="truncate font-semibold text-ink">{ds?.name ?? '…'}</b>
          </nav>
          <span className="flex-1" />
          <AccountMenu />
        </DashHeader>

        <DashContent>
          <div className="flex max-w-[1000px] flex-wrap items-end gap-4">
            <div className="min-w-0">
              <DashTitle className="truncate">{ds?.name ?? '…'}</DashTitle>
              <DashSubtitle>
                {ds
                  ? [
                      `Design system · ${scope}`,
                      latest
                        ? `v${latest} published ${timeAgo(ds.publishedAt ?? ds.updatedAt)}${ds.publishedBy ? ` by ${ds.publishedBy}` : ''}`
                        : 'never published',
                      `used by ${plural(ds.canvasCount, 'canvas')}`,
                    ].join(' · ')
                  : '…'}
              </DashSubtitle>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {ds?.isDefault && <Badge>workspace default</Badge>}
              {ds && latest > 0 && ds.draftChanged && <Badge tone="accent">unpublished changes</Badge>}
              <Button variant="ghost" disabled={!ds} onClick={() => ds && open(ds.sourceCanvasId, ds.name)}>
                Edit draft
              </Button>
              {ds?.canPublish && (
                <Button
                  variant="primary"
                  disabled={busy || !pending}
                  title={pending ? undefined : 'The draft matches the latest version'}
                  onClick={() =>
                    run(() => api.publishDesignSystem(ds.id), 'Publish failed', `Published v${latest + 1}`)
                  }
                >
                  Publish v{latest + 1}
                </Button>
              )}
            </div>
          </div>
          {ds && <Swatches colors={ds.swatches} className="mt-4 h-3 max-w-[1000px]" />}

          {!ds ? (
            <Skeleton className="mt-5 min-h-[260px] max-w-[1000px] rounded-[12px]" />
          ) : (
            <div className="mt-5 grid max-w-[1000px] items-start gap-4 md:grid-cols-2">
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Draft</CardTitle>
                  <CardDescription>
                    Edited on the draft canvas; its frames are the specimens. Canvases using the system see a change
                    when it is published.
                  </CardDescription>
                </CardHeader>
                <CardRow label="Tokens">{ds.draft.tokens}</CardRow>
                <CardRow label="Fonts">{ds.draft.fonts.join(', ') || 'none'}</CardRow>
                <CardRow label="Components">
                  {ds.draft.components.length
                    ? ds.draft.components.map((name) => (
                        <Badge key={name} tone="outline">
                          &lt;{name}&gt;
                        </Badge>
                      ))
                    : 'none'}
                </CardRow>
                <CardRow label="Rules">{ds.draft.rules.join(', ') || 'none'}</CardRow>
                <CardRow label="Specimens">{plural(ds.draft.frames, 'frame')}</CardRow>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Canvases using it</CardTitle>
                  <CardDescription>
                    {ds.canvases.length
                      ? 'Each follows the latest version unless it is pinned to one.'
                      : `None yet. Pick it in a canvas’s Design tab${ds.workspaceId ? ', or make it the workspace default' : ''}.`}
                  </CardDescription>
                </CardHeader>
                {ds.canvases.map((c) => (
                  <CardRow
                    key={c.id}
                    action={
                      <Button size="sm" variant="ghost" onClick={() => open(c.id, c.name)}>
                        Open
                      </Button>
                    }
                  >
                    <span className="truncate font-semibold">{c.name}</span>
                    <span className="text-[12px] text-ink-faint">
                      {c.pin ? `pinned to v${c.pin}` : `v${latest}, follows the latest`}
                    </span>
                  </CardRow>
                ))}
              </Card>

              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Versions</CardTitle>
                  <CardDescription>
                    Restoring publishes an old version again as the newest, so canvases following the system get it.
                  </CardDescription>
                </CardHeader>
                {ds.versions.length === 0 && <CardRow>Not published yet.</CardRow>}
                {ds.versions.map((v) => (
                  <CardRow
                    key={v.version}
                    action={
                      ds.canPublish && v.version !== latest ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => api.publishDesignSystem(ds.id, { fromVersion: v.version }),
                              'Restore failed',
                              `Restored v${v.version} as v${latest + 1}`,
                            )
                          }
                        >
                          Restore
                        </Button>
                      ) : undefined
                    }
                  >
                    <b className="font-mono text-[12px]">v{v.version}</b>
                    <span className="min-w-0 truncate">{v.note || '—'}</span>
                    <span className="text-[12px] text-ink-faint">
                      {v.publishedBy} · {timeAgo(v.publishedAt)}
                    </span>
                  </CardRow>
                ))}
              </Card>

              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Settings</CardTitle>
                  <CardDescription>
                    {ds.canPublish
                      ? 'You can publish, rename and delete this system.'
                      : `Only its owner${ds.workspaceId ? ' and the workspace admins' : ''} can publish or change it.`}
                  </CardDescription>
                </CardHeader>
                <CardRow
                  label="Name"
                  action={
                    ds.canPublish && renaming === null ? (
                      <Button size="sm" variant="ghost" onClick={() => setRenaming(ds.name)}>
                        Rename
                      </Button>
                    ) : undefined
                  }
                >
                  {renaming === null ? (
                    ds.name
                  ) : (
                    <form
                      className="flex w-full gap-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (!renaming.trim()) return
                        void run(() => api.renameDesignSystem(ds.id, renaming), 'Rename failed').then(
                          (ok) => ok && setRenaming(null),
                        )
                      }}
                    >
                      <Input
                        autoFocus
                        value={renaming}
                        maxLength={80}
                        aria-label="Design system name"
                        onChange={(e) => setRenaming(e.target.value)}
                      />
                      <Button size="sm" variant="primary" type="submit" disabled={busy || !renaming.trim()}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" type="button" onClick={() => setRenaming(null)}>
                        Cancel
                      </Button>
                    </form>
                  )}
                </CardRow>
                {ds.workspaceId && (
                  <CardRow
                    label="Workspace default"
                    action={
                      ws && ws.role !== 'member' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || (!ds.isDefault && !latest)}
                          onClick={() =>
                            run(
                              () => api.setDefaultDesignSystem(ds.workspaceId!, ds.isDefault ? null : ds.id),
                              'Couldn’t change the default',
                            )
                          }
                        >
                          {ds.isDefault ? 'Unset' : 'Make default'}
                        </Button>
                      ) : undefined
                    }
                  >
                    {ds.isDefault
                      ? `New canvases in ${scope} start on it.`
                      : latest
                        ? 'Not the default.'
                        : 'Publish it before making it the default.'}
                  </CardRow>
                )}
                {ds.canPublish && (
                  <CardRow
                    label="Delete"
                    action={
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-accent-ink"
                        disabled={busy || ds.canvasCount > 0}
                        onClick={() => setConfirmDelete(true)}
                      >
                        Delete
                      </Button>
                    }
                  >
                    {ds.canvasCount > 0
                      ? `Possible once no canvas uses it (${plural(ds.canvasCount, 'canvas')} do).`
                      : 'Deletes the draft canvas and every version.'}
                  </CardRow>
                )}
              </Card>
            </div>
          )}
        </DashContent>
      </DashMain>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${ds?.name ?? 'design system'}”?`}
        description="Its draft canvas, specimens and every published version are deleted. This can’t be undone."
        confirmLabel="Delete design system"
        destructive
        onConfirm={() => {
          if (!ds) return
          api
            .deleteDesignSystem(ds.id)
            .then(() => navigate('/'))
            .catch((caught) => showToast(errorMessage(caught, 'Couldn’t delete the design system')))
        }}
      />
      {toast && <Toast>{toast}</Toast>}
    </DashLayout>
  )
}
