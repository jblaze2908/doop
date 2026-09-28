import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceDetail, WorkspaceRole } from '../../shared/types'
import { navigate } from '../App'
import { api, errorMessage } from '../lib/api'
import { useHomeFeed } from '../lib/homeFeed'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { AccountMenu, IconBack, IconChevron, IconGear, IconShare } from '../components/DashShell'
import { Avatar } from '../components/ui/avatar'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardBody, CardDescription, CardHeader, CardRow, CardTitle } from '../components/ui/card'
import { ConfirmDialog } from '../components/ui/alert-dialog'
import { Input, Sel } from '../components/ui/input'
import { Skeleton } from '../components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Toast } from '../components/ui/toast'
import { Wordmark } from '../components/ui/wordmark'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashNavItem,
  DashSectionLabel,
  DashSidebar,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'
import { timeAgo } from '../lib/time'

type Pane = 'members' | 'general'

/** One workspace's settings, in the dashboard shell: who is in it, and the name. */
export function Workspace({ workspaceId }: { workspaceId: string }) {
  const { data: session } = authClient.useSession()
  const meId = session?.user.id
  const [ws, setWs] = useState<WorkspaceDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>('members')

  const reload = useCallback(() => {
    api
      .getWorkspace(workspaceId)
      .then(setWs)
      .catch(() => setMissing(true))
  }, [workspaceId])

  useEffect(reload, [reload])
  /* members, roles and the name change live when another admin edits them */
  useHomeFeed({ refresh: reload })

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
  }

  function handle(caught: unknown, fallback: string) {
    showToast(errorMessage(caught, fallback))
  }

  const admin = ws ? ws.role !== 'member' : false
  const isOwner = ws?.role === 'owner'

  if (missing) {
    return (
      <DashLayout>
        <DashMain>
          <DashHeader>
            <span className="flex-1" />
            <AccountMenu />
          </DashHeader>
          <DashContent>
            <DashTitle>Workspace not found</DashTitle>
            <DashSubtitle>It may have been deleted, or you are no longer a member.</DashSubtitle>
            <Button className="mt-5" onClick={() => navigate('/')}>
              Back to canvases
            </Button>
          </DashContent>
        </DashMain>
      </DashLayout>
    )
  }

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
        <DashSectionLabel>{ws?.name ?? 'Workspace'}</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <DashNavItem icon={<IconShare />} active={pane === 'members'} onClick={() => setPane('members')}>
            People
          </DashNavItem>
          <DashNavItem icon={<IconGear />} active={pane === 'general'} onClick={() => setPane('general')}>
            General
          </DashNavItem>
        </nav>
      </DashSidebar>

      <DashMain>
        <DashHeader>
          <nav className="flex items-center gap-2 text-[13px] text-ink-faint" aria-label="Breadcrumb">
            <Button
              variant="link"
              size="sm"
              className="px-0 py-0 text-[13px] font-normal text-ink-faint hover:text-ink"
              onClick={() => navigate('/')}
            >
              Home
            </Button>
            <IconChevron />
            <b className="truncate font-semibold text-ink">{ws?.name ?? '…'}</b>
          </nav>
          <span className="flex-1" />
          <AccountMenu />
        </DashHeader>

        <DashContent>
          <div className="flex items-start gap-4 md:items-end">
            <div className="min-w-0">
              <DashTitle className="truncate">{ws?.name ?? '…'}</DashTitle>
              <DashSubtitle>
                {ws
                  ? `${ws.memberCount} ${ws.memberCount === 1 ? 'person' : 'people'} · ${ws.canvasCount} ${
                      ws.canvasCount === 1 ? 'canvas' : 'canvases'
                    }`
                  : '…'}
              </DashSubtitle>
            </div>
          </div>

          <Tabs value={pane} onValueChange={(next) => setPane(next as Pane)} className="mt-4 flex md:hidden">
            <TabsList className="h-10 w-full border border-line bg-surface p-1 shadow-card">
              <TabsTrigger value="members">People</TabsTrigger>
              <TabsTrigger value="general">General</TabsTrigger>
            </TabsList>
          </Tabs>

          {!ws ? (
            <Skeleton className="mt-5 min-h-[260px] max-w-[1000px] rounded-[12px]" />
          ) : pane === 'members' ? (
            <MembersPane ws={ws} meId={meId} admin={admin} onChange={reload} onError={handle} onToast={showToast} />
          ) : (
            <GeneralPane ws={ws} admin={admin} isOwner={isOwner} onChange={reload} onToast={showToast} />
          )}
        </DashContent>
      </DashMain>

      {toast && <Toast>{toast}</Toast>}
    </DashLayout>
  )
}

/* ---- people ---- */

function MembersPane({
  ws,
  meId,
  admin,
  onChange,
  onError,
  onToast,
}: {
  ws: WorkspaceDetail
  meId?: string
  admin: boolean
  onChange: () => void
  onError: (caught: unknown, fallback: string) => void
  onToast: (message: string) => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null)

  async function invite() {
    const clean = email.trim()
    if (!clean || busy) return
    setBusy(true)
    try {
      const result = await api.inviteToWorkspace(ws.id, clean, role)
      posthog.capture('workspace_member_invited', { pending: 'invite' in result })
      if ('member' in result) onToast(`${result.member.name} is in`)
      else onToast(result.emailed ? `Invite emailed to ${clean}` : `${clean} joins when they sign up with that email`)
      setEmail('')
      onChange()
    } catch (caught) {
      onError(caught, 'Couldn’t invite')
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(userId: string, next: WorkspaceRole) {
    try {
      await api.setWorkspaceRole(ws.id, userId, next)
      onChange()
    } catch (caught) {
      onError(caught, 'Couldn’t change the role')
    }
  }

  async function remove(userId: string) {
    try {
      await api.removeWorkspaceMember(ws.id, userId)
      if (userId === meId) navigate('/')
      else onChange()
    } catch (caught) {
      onError(caught, 'Couldn’t remove')
    }
  }

  async function revoke(inviteId: string) {
    try {
      await api.revokeWorkspaceInvite(ws.id, inviteId)
      onChange()
    } catch (caught) {
      onError(caught, 'Couldn’t revoke the invite')
    }
  }

  return (
    <Card className="mt-4 max-w-[1000px] overflow-hidden sm:mt-5">
      <CardHeader>
        <CardTitle>People</CardTitle>
        <CardDescription>
          Everyone here opens every canvas in the workspace. Admins invite and remove people.
        </CardDescription>
        {admin && (
          <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row">
            <Input
              className="flex-1 rounded-[10px] bg-paper focus:ring-0"
              placeholder="Invite by email"
              type="email"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && invite()}
              aria-label="Email to invite"
            />
            <Sel
              value={role}
              disabled={busy}
              onChange={(e) => setRole(e.target.value as WorkspaceRole)}
              aria-label="Role"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Sel>
            <Button variant="primary" className="justify-center" disabled={busy || !email.trim()} onClick={invite}>
              {busy ? 'Inviting…' : 'Invite'}
            </Button>
          </div>
        )}
      </CardHeader>
      <div>
        {ws.members.map((m) => {
          const self = m.userId === meId
          const isOwnerRow = m.role === 'owner'
          return (
            <CardRow
              key={m.userId}
              className="py-3"
              action={
                isOwnerRow ? (
                  <Badge tone="accent">owner</Badge>
                ) : admin ? (
                  <>
                    <Sel
                      value={m.role}
                      onChange={(e) => changeRole(m.userId, e.target.value as WorkspaceRole)}
                      aria-label={`Role of ${m.name}`}
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </Sel>
                    <Button
                      variant="bare-danger"
                      size="sm"
                      onClick={() => setRemoving({ userId: m.userId, name: self ? 'yourself' : m.name })}
                    >
                      {self ? 'Leave' : 'Remove'}
                    </Button>
                  </>
                ) : (
                  <>
                    <Badge>{m.role}</Badge>
                    {self && (
                      <Button
                        variant="bare-danger"
                        size="sm"
                        onClick={() => setRemoving({ userId: m.userId, name: 'yourself' })}
                      >
                        Leave
                      </Button>
                    )}
                  </>
                )
              }
            >
              <Avatar name={m.name} className="size-8 flex-none border-0 text-xs" />
              <span className="flex min-w-0 flex-col leading-[1.3]">
                <b className="truncate text-[13px] font-semibold">
                  {m.name}
                  {self ? ' (you)' : ''}
                </b>
                <span className="truncate text-[12px] text-ink-faint">
                  {m.email} · joined {timeAgo(m.addedAt)}
                </span>
              </span>
            </CardRow>
          )
        })}
        {ws.invites.length > 0 && (
          <CardBody className="border-t border-line-soft bg-paper/60">
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
              Waiting to sign up
            </span>
            {ws.invites.map((inv) => (
              <div key={inv.id} className="mt-2 flex items-center gap-3 text-[13px]">
                <span className="min-w-0 flex-1 truncate">
                  {inv.email}{' '}
                  <span className="text-ink-faint">
                    · {inv.role} · invited by {inv.invitedByName}
                  </span>
                </span>
                <Button variant="bare" size="sm" onClick={() => revoke(inv.id)}>
                  Revoke
                </Button>
              </div>
            ))}
          </CardBody>
        )}
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing?.userId === meId ? `Leave “${ws.name}”?` : `Remove ${removing?.name ?? ''}?`}
        description={
          removing?.userId === meId
            ? 'You lose access to every canvas in this workspace except the ones you own.'
            : 'They lose access to every canvas in this workspace except the ones they own.'
        }
        confirmLabel={removing?.userId === meId ? 'Leave workspace' : 'Remove'}
        destructive
        onConfirm={() => {
          if (removing) void remove(removing.userId)
          setRemoving(null)
        }}
      />
    </Card>
  )
}

/* ---- general ---- */

function GeneralPane({
  ws,
  admin,
  isOwner,
  onChange,
  onToast,
}: {
  ws: WorkspaceDetail
  admin: boolean
  isOwner: boolean
  onChange: () => void
  onToast: (message: string) => void
}) {
  const [name, setName] = useState(ws.name)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function rename() {
    const clean = name.trim()
    if (!clean || clean === ws.name || busy) return
    setBusy(true)
    try {
      await api.renameWorkspace(ws.id, clean)
      onChange()
      onToast('Renamed')
    } catch (caught) {
      onToast(errorMessage(caught, 'Couldn’t rename'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await api.deleteWorkspace(ws.id)
      posthog.capture('workspace_deleted')
      navigate('/')
    } catch (caught) {
      onToast(errorMessage(caught, 'Couldn’t delete the workspace'))
      setBusy(false)
    }
  }

  return (
    <>
      <Card className="mt-4 max-w-[1000px] overflow-hidden sm:mt-5">
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>The name everyone sees in their sidebar and on canvases filed here.</CardDescription>
        </CardHeader>
        <CardRow
          label="Name"
          action={
            admin ? (
              <Button size="sm" disabled={busy || !name.trim() || name.trim() === ws.name} onClick={rename}>
                Save
              </Button>
            ) : undefined
          }
        >
          <Input
            className="max-w-[360px] rounded-[10px] bg-paper focus:ring-0"
            value={name}
            maxLength={80}
            disabled={!admin || busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && rename()}
            aria-label="Workspace name"
          />
        </CardRow>
        <CardRow label="Created">
          <span className="text-[13px] text-ink-soft">{timeAgo(ws.createdAt)}</span>
        </CardRow>
      </Card>
      {isOwner && (
        <Card tone="flat" className="mt-4 max-w-[1000px] overflow-hidden border-accent-ink/30">
          <CardHeader>
            <CardTitle className="text-accent-ink">Delete workspace</CardTitle>
            <CardDescription>
              Every canvas goes back to the personal space of whoever owns it — nothing is deleted. People lose access
              to canvases that aren’t theirs.
            </CardDescription>
          </CardHeader>
          <CardBody>
            <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete “{ws.name}”
            </Button>
          </CardBody>
        </Card>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${ws.name}”?`}
        description="Canvases return to their owners. This can’t be undone."
        confirmLabel="Delete workspace"
        destructive
        onConfirm={() => {
          setConfirmDelete(false)
          void remove()
        }}
      />
    </>
  )
}
