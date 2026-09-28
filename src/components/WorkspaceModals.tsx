import { useState } from 'react'
import type { WorkspaceSummary } from '../../shared/types'
import { api, errorMessage, type DesignSystemRow } from '../lib/api'
import { posthog } from '../lib/posthog'
import { Button } from './ui/button'
import { Input, Sel } from './ui/input'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from './ui/modal'

/** The workspace dialogs every page shares: creating one (or a design system
 *  in one), and moving a canvas in or out. */

/* ---- create ---- */

export function CreateWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (workspace: WorkspaceSummary) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      const ws = await api.createWorkspace(clean)
      posthog.capture('workspace_created')
      onCreated(ws)
    } catch (caught) {
      setError(errorMessage(caught, 'Couldn’t create the workspace'))
      setBusy(false)
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalEyebrow>Workspaces</ModalEyebrow>
        <ModalTitle className="mt-2">Name your workspace</ModalTitle>
        <ModalLede>
          A workspace is your team’s shared home: everyone in it can open every canvas inside. You can move existing
          canvases in afterwards.
        </ModalLede>
        <Input
          className="mt-5 rounded-[10px] bg-paper focus:ring-0"
          autoFocus
          placeholder="Acme Design"
          value={name}
          maxLength={80}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && create()}
          aria-label="Workspace name"
        />
        {error && <p className="mt-2 text-[12px] text-accent-ink">{error}</p>}
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create workspace'}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}

/* ---- create a design system ---- */

export function CreateDesignSystemModal({
  workspaces,
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaces: WorkspaceSummary[]
  /** preselected scope; undefined = personal */
  workspaceId?: string
  onClose: () => void
  onCreated: (system: DesignSystemRow) => void
}) {
  const [name, setName] = useState('')
  const [target, setTarget] = useState(workspaceId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      const system = await api.createDesignSystem({ name: clean, ...(target ? { workspaceId: target } : {}) })
      posthog.capture('design_system_created', { workspace: !!target })
      onCreated(system)
    } catch (caught) {
      setError(errorMessage(caught, 'Couldn’t create the design system'))
      setBusy(false)
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalEyebrow>Design systems</ModalEyebrow>
        <ModalTitle className="mt-2">Name your design system</ModalTitle>
        <ModalLede>
          Tokens, fonts, CSS, components and rules that the canvases of one workspace share. You build it on its draft,
          then publish; canvases using it follow each publish.
        </ModalLede>
        <Input
          className="mt-5 rounded-[10px] bg-paper focus:ring-0"
          autoFocus
          placeholder="Ledgerline"
          value={name}
          maxLength={80}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && create()}
          aria-label="Design system name"
        />
        <Sel
          className="mt-3 w-full"
          value={target}
          disabled={busy}
          onChange={(event) => setTarget(event.target.value)}
          aria-label="Where it lives"
        >
          <option value="">Personal — for your own canvases</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} — for its canvases
            </option>
          ))}
        </Sel>
        {error && <p className="mt-2 text-[12px] text-accent-ink">{error}</p>}
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create design system'}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}

/* ---- move a canvas ---- */

export function MoveCanvasModal({
  canvas,
  workspaces,
  onClose,
  onMoved,
}: {
  canvas: { id: string; name: string; workspaceId?: string }
  workspaces: WorkspaceSummary[]
  onClose: () => void
  /** detachedSystem: the design system the canvas left behind (it kept a copy of its design) */
  onMoved: (workspaceId: string | null, detachedSystem?: string) => void
}) {
  const [target, setTarget] = useState<string>(canvas.workspaceId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function move() {
    if (busy) return
    setBusy(true)
    setError(null)
    const workspaceId = target || null
    try {
      const moved = await api.moveCanvas(canvas.id, workspaceId)
      posthog.capture('canvas_moved', { into: !!workspaceId })
      onMoved(workspaceId, moved.detachedSystem)
    } catch (caught) {
      setError(errorMessage(caught, 'Couldn’t move the canvas'))
      setBusy(false)
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalTitle>Move “{canvas.name}”</ModalTitle>
        <ModalLede>
          A canvas in a workspace is open to everyone in it. Move it back to Personal and only you and the people you
          invited keep access.
        </ModalLede>
        <Sel
          className="mt-5 w-full"
          value={target}
          disabled={busy}
          onChange={(event) => setTarget(event.target.value)}
          aria-label="Destination"
        >
          <option value="">Personal — just you and invitees</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Sel>
        {error && <p className="mt-2 text-[12px] text-accent-ink">{error}</p>}
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={move} disabled={busy || (target || '') === (canvas.workspaceId ?? '')}>
            {busy ? 'Moving…' : 'Move canvas'}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}
