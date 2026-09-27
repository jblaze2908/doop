import { useEffect, useState } from 'react'
import type { Canvas } from '../../shared/types'
import { navigate } from '../App'
import type { WorkspaceSummary } from '../../shared/types'
import { api, ApiError, paywalledWorkspace, type CanvasMember } from '../lib/api'
import { UpgradeModal } from './WorkspaceModals'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { Avatar } from './ui/avatar'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { BuildingIcon, XIcon } from './ui/icons'
import { Input, Sel } from './ui/input'
import { Modal, ModalTitle } from './ui/modal'

type ShareableCanvas = Pick<Canvas, 'id' | 'name' | 'ownerId' | 'linkAccess' | 'memberIds' | 'workspaceId'>
type SharePatch = Partial<Pick<ShareableCanvas, 'linkAccess' | 'memberIds' | 'workspaceId'>>

/* One sharing surface for the canvas and dashboard. The caller owns canvas
   state; this component reports optimistic access changes back to it. */
export function ShareModal({
  canvas,
  onChange,
  onClose,
  onCopied,
}: {
  canvas: ShareableCanvas
  onChange: (patch: SharePatch) => void
  onClose: () => void
  onCopied: () => void
}) {
  const { data: session } = authClient.useSession()
  const meId = session?.user?.id
  const isOwner = !!canvas.ownerId && canvas.ownerId === meId
  const linkEdits = canvas.linkAccess === 'edit'
  const [people, setPeople] = useState<CanvasMember[] | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [upgrade, setUpgrade] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api
      .listMembers(canvas.id)
      .then((members) => active && setPeople(members))
      .catch(() => active && setPeople([]))
    api
      .listWorkspaces()
      .then((res) => active && setWorkspaces(res.workspaces))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [canvas.id])

  const workspace = canvas.workspaceId ? workspaces.find((w) => w.id === canvas.workspaceId) : undefined

  async function move(target: string) {
    if (busy) return
    const workspaceId = target || null
    setBusy(true)
    setError(null)
    try {
      await api.moveCanvas(canvas.id, workspaceId)
      posthog.capture('canvas_moved', { into: !!workspaceId })
      onChange({ workspaceId: workspaceId ?? undefined })
    } catch (caught) {
      const walled = paywalledWorkspace(caught)
      if (walled) setUpgrade(walled)
      else setError(caught instanceof ApiError ? String(caught.body.error ?? 'move failed') : 'move failed')
    } finally {
      setBusy(false)
    }
  }

  async function invite() {
    const clean = email.trim()
    if (!clean || busy || people === null) return
    setBusy(true)
    setError(null)
    try {
      const member = await api.inviteMember(canvas.id, clean)
      setPeople((current) =>
        current?.some((person) => person.userId === member.userId) ? current : [...(current ?? []), member],
      )
      if (!canvas.memberIds?.includes(member.userId)) {
        onChange({ memberIds: [...(canvas.memberIds ?? []), member.userId] })
      }
      setEmail('')
    } catch (caught) {
      setError(caught instanceof ApiError ? String(caught.body.error ?? 'invite failed') : 'invite failed')
    }
    setBusy(false)
  }

  async function remove(userId: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.removeMember(canvas.id, userId)
      setPeople((current) => current?.filter((person) => person.userId !== userId) ?? null)
      onChange({ memberIds: canvas.memberIds?.filter((id) => id !== userId) })
      if (userId === meId && !isOwner) navigate('/')
    } catch (caught) {
      setError(caught instanceof ApiError ? String(caught.body.error ?? 'removal failed') : 'removal failed')
    } finally {
      setBusy(false)
    }
  }

  async function toggleLink(next: boolean) {
    if (busy) return
    const linkAccess = next ? 'edit' : 'none'
    setBusy(true)
    setError(null)
    try {
      await api.setLinkAccess(canvas.id, linkAccess)
      onChange({ linkAccess })
    } catch (caught) {
      setError(
        caught instanceof ApiError ? String(caught.body.error ?? 'access update failed') : 'access update failed',
      )
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    setError(null)
    try {
      await navigator.clipboard.writeText(`${location.origin}/c/${canvas.id}`)
      posthog.capture('canvas_link_shared')
      onCopied()
    } catch {
      setError('Couldn’t copy the link. Copy the URL from your browser instead.')
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <div className="flex items-start justify-between gap-3">
          <ModalTitle className="min-w-0">Share “{canvas.name}”</ModalTitle>
          <Button variant="ghost" size="icon" className="size-10" aria-label="Close sharing" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        {isOwner && (
          <>
            <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row">
              <Input
                className="flex-1 rounded-[10px] bg-paper focus:ring-0"
                autoFocus
                placeholder="Invite by email (doop account)"
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && invite()}
              />
              <Button
                variant="primary"
                className="justify-center"
                disabled={busy || people === null || !email.trim()}
                onClick={invite}
              >
                Invite
              </Button>
            </div>
          </>
        )}
        {error && <p className="mx-[2px] mt-2 text-[12px] text-accent-ink">{error}</p>}
        <div className="mt-[14px] mb-1 flex max-h-[40vh] flex-col gap-[2px] overflow-y-auto">
          {(people ?? []).map((person) => (
            <div key={person.userId} className="flex items-center gap-2.5 px-[2px] py-1.5">
              <Avatar name={person.name} className="size-7 flex-none border-0 text-xs" />
              <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                <b className="overflow-hidden whitespace-nowrap text-ellipsis text-[13px] font-semibold">
                  {person.name}
                  {person.userId === meId ? ' (you)' : ''}
                </b>
                <span className="overflow-hidden whitespace-nowrap text-ellipsis text-[12px] text-ink-faint">
                  {person.email}
                </span>
              </span>
              {person.owner ? (
                <span className="flex-none text-[12px] text-ink-faint">Owner</span>
              ) : isOwner || person.userId === meId ? (
                <Button
                  variant="bare"
                  size="icon-sm"
                  className="flex-none text-[13px] hover:bg-accent-ink/10 hover:text-accent-ink"
                  title={person.userId === meId ? 'Leave this canvas' : 'Remove'}
                  disabled={busy}
                  onClick={() => remove(person.userId)}
                >
                  ✕
                </Button>
              ) : (
                <span className="flex-none text-[12px] text-ink-faint">Can edit</span>
              )}
            </div>
          ))}
          {people === null && <p className="text-[12px] text-ink-faint">Loading…</p>}
          {canvas.workspaceId && (
            <div className="flex items-center gap-2.5 px-[2px] py-1.5">
              <span className="grid size-7 flex-none place-items-center rounded-full bg-paper-deep text-ink-soft">
                <BuildingIcon width={14} height={14} aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                <b className="truncate text-[13px] font-semibold">Everyone in {workspace?.name ?? 'the workspace'}</b>
                <span className="truncate text-[12px] text-ink-faint">
                  {workspace
                    ? `${workspace.memberCount} ${workspace.memberCount === 1 ? 'person' : 'people'}`
                    : 'workspace members'}
                </span>
              </span>
              <span className="flex-none text-[12px] text-ink-faint">Can edit</span>
            </div>
          )}
        </div>
        {/* filing: a workspace canvas is open to the whole team, so the
            choice sits with the access controls rather than in a menu */}
        {isOwner && workspaces.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-2 border-t border-line-soft pt-3.5 sm:flex-row sm:items-center">
            <span className="text-[13px] font-medium text-ink">Workspace</span>
            <Sel
              className="sm:ml-auto sm:w-[240px]"
              value={canvas.workspaceId ?? ''}
              disabled={busy}
              onChange={(event) => move(event.target.value)}
              aria-label="Workspace this canvas lives in"
            >
              <option value="">Personal — invite-only</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.active ? '' : ' (needs a plan)'}
                </option>
              ))}
            </Sel>
          </div>
        )}
        <div className="mt-2.5 flex flex-col items-stretch justify-between gap-2.5 border-t border-line-soft pt-3.5 sm:flex-row sm:items-center">
          {isOwner ? (
            <label
              className="relative flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink"
              title="Off = only you and invited people can open this canvas"
            >
              <Checkbox checked={linkEdits} disabled={busy} onChange={(event) => toggleLink(event.target.checked)} />
              Anyone with the link can edit
            </label>
          ) : (
            <span className="text-xs text-ink-faint">
              {linkEdits ? 'Anyone with the link can edit' : 'Invite-only canvas'}
            </span>
          )}
          <Button className="justify-center" onClick={copy}>
            ⧉ Copy link
          </Button>
        </div>
        {upgrade && (
          <UpgradeModal
            workspaceId={upgrade}
            reason="Moving a canvas into a workspace needs a Team plan."
            onClose={() => setUpgrade(null)}
          />
        )}
      </>
    </Modal>
  )
}
