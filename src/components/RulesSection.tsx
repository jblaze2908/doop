import { useEffect, useMemo, useState } from 'react'
import type { GuidelineDoc } from '../../shared/types'
import { mergeGuidelines, originOf, type DesignOrigin } from '../../shared/designSystem'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { ListHint, ListMeta, ListRow, ListSection, ListSummary, ListTitle } from './ui/list'
import { MarkdownBlock, Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
import { ConfirmDialog } from './ui/alert-dialog'

const MAX_GUIDELINE_CHARS = 24_000
const MAX_TITLE_CHARS = 80

/* Timestamp/author line under a modal heading. */
const meta = 'mt-1.5 text-[11.5px] text-ink-faint'
const errorText = 'mt-2.5 text-[13px] text-accent-ink'
const modalHead = 'flex flex-wrap items-baseline gap-2.5'

/** Pretty display name: explicit title, else the prettified slug. */
function guideTitle(doc: Pick<GuidelineDoc, 'name' | 'title'>): string {
  return doc.title ?? doc.name.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function summarize(markdown: string): string {
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line) return line.length > 90 ? line.slice(0, 87) + '…' : line
  }
  return ''
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** "Acme · " or "Overrides Acme · " ahead of a row's meta line; nothing for the canvas's own. */
export function originPrefix(origin: DesignOrigin, systemName: string | undefined): string {
  if (!systemName || origin === 'local') return ''
  return origin === 'system' ? `${systemName} · ` : `Overrides ${systemName} · `
}

/* stable fallback: a fresh [] from a selector re-renders on every store update */
const NO_DOCS: GuidelineDoc[] = []

/** The Rules section of the Design tab: style guides every agent reads before
 *  designing here, the design system's included (read-only until overridden). */
export function RulesSection({ canvasId }: { canvasId: string }) {
  const ownDocs = useStore((s) => s.canvas?.guidelines ?? NO_DOCS)
  const systemDocs = useStore((s) => s.system?.snapshot.guidelines)
  const systemName = useStore((s) => s.system?.system.name)
  const docs = useMemo(() => mergeGuidelines(systemDocs, ownDocs), [systemDocs, ownDocs])
  /** slug of the open guide, '' = create a new one, null = closed */
  const [openGuide, setOpenGuide] = useState<string | null>(null)

  return (
    <>
      <ListSection>
        <span>Rules</span>
        <Button
          variant="solid"
          size="sm"
          className="flex-none text-[11.5px] font-bold"
          onClick={() => setOpenGuide('')}
        >
          + New
        </Button>
      </ListSection>
      {docs.length === 0 && <ListHint>Style guides every agent reads before designing here.</ListHint>}
      {docs.map((d) => (
        <ListRow key={d.name} onClick={() => setOpenGuide(d.name)}>
          <ListTitle>{guideTitle(d)}</ListTitle>
          <ListSummary>{summarize(d.markdown)}</ListSummary>
          <ListMeta>
            {originPrefix(originOf(d.name, systemDocs, ownDocs), systemName)}
            {d.updatedBy} · {timeAgo(d.updatedAt)}
          </ListMeta>
        </ListRow>
      ))}
      {openGuide !== null && (
        <GuideModal canvasId={canvasId} name={openGuide || null} onClose={() => setOpenGuide(null)} />
      )}
    </>
  )
}

type Mode = 'read' | 'edit' | 'history'

/** One design guide in a modal: read, edit (title + markdown), version
 *  history with restore, delete. name = null opens in create mode. A guide
 *  from the design system reads until overridden; an override resets to it. */
function GuideModal({ canvasId, name, onClose }: { canvasId: string; name: string | null; onClose: () => void }) {
  const own = useStore((s) => s.canvas?.guidelines?.find((d) => d.name === name) ?? null)
  const fromSystem = useStore((s) => s.system?.snapshot.guidelines.find((d) => d.name === name) ?? null)
  const systemName = useStore((s) => s.system?.system.name)
  const doc = own ?? fromSystem
  const origin: DesignOrigin = own ? (fromSystem ? 'override' : 'local') : 'system'
  const creating = name === null
  const [mode, setMode] = useState<Mode>('read')
  const [titleDraft, setTitleDraft] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function save(slug: string, markdown: string, title?: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.setGuideline(canvasId, slug, markdown, title)
      if (markdown.trim() && !creating) setMode('read')
      else if (!markdown.trim() && origin === 'override')
        setMode('read') // reset: the system's version shows again
      else onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : 'save failed')
    } finally {
      setBusy(false)
    }
  }

  const editing = creating || mode === 'edit'

  return (
    <Modal size="xl" onClose={() => !busy && onClose()}>
      <>
        {editing ? (
          <>
            <ModalTitle className="sr-only">{creating ? 'New rule' : 'Edit rule'}</ModalTitle>
            <Input
              inputSize="lg"
              className="rounded-[10px] bg-paper font-display font-extrabold focus:ring-0 md:text-[19px]"
              autoFocus={creating}
              placeholder="Name, e.g. “Featured Images”"
              value={titleDraft}
              maxLength={MAX_TITLE_CHARS}
              disabled={busy}
              onChange={(e) => setTitleDraft(e.target.value)}
            />
            <div className={meta}>
              id: {creating ? slugify(titleDraft) || '…' : doc?.name}
              {origin === 'system' && !creating ? ` · saving overrides “${systemName}” on this canvas only` : ''}
            </div>
            <Textarea
              className="mt-3 min-h-[38dvh] resize-y rounded-[12px] bg-surface px-4 py-3.5 font-mono leading-[1.65] focus:ring-0 sm:min-h-[46vh] md:text-[12.5px]"
              autoFocus={!creating}
              placeholder={'# Rules\n\nPalette, fonts, layout recipes, asset URLs…'}
              value={draft}
              maxLength={MAX_GUIDELINE_CHARS}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
            />
            {error && <p className={errorText}>{error}</p>}
            <ModalActions className="items-center">
              <span className={meta}>
                {draft.length.toLocaleString()} / {MAX_GUIDELINE_CHARS.toLocaleString()}
              </span>
              <ModalSpacer />
              <Button variant="ghost" disabled={busy} onClick={() => (creating ? onClose() : setMode('read'))}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || !draft.trim() || (creating && !slugify(titleDraft))}
                onClick={() =>
                  creating
                    ? save(slugify(titleDraft), draft, titleDraft.trim())
                    : save(doc!.name, draft, titleDraft.trim() || undefined)
                }
              >
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </ModalActions>
          </>
        ) : !doc ? (
          /* deleted while open (possibly by someone else) */
          <>
            <ModalTitle className="sr-only">Rule</ModalTitle>
            <ModalLede>This design guide no longer exists.</ModalLede>
            <ModalActions>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </ModalActions>
          </>
        ) : mode === 'history' ? (
          <GuideHistory
            canvasId={canvasId}
            doc={doc}
            busy={busy}
            onRestore={(markdown) => save(doc.name, markdown)}
            onBack={() => setMode('read')}
          />
        ) : (
          <>
            <div className={modalHead}>
              <ModalTitle>{guideTitle(doc)}</ModalTitle>
              <Badge tone="outline" className="rounded-full px-2 py-px">
                {doc.name}
              </Badge>
              {origin !== 'local' && systemName && (
                <Badge className="rounded-full px-2 py-px">
                  {origin === 'system' ? `from ${systemName}` : `overrides ${systemName}`}
                </Badge>
              )}
            </div>
            <div className={meta}>
              edited by {doc.updatedBy} · {new Date(doc.updatedAt).toLocaleString()}
              {origin === 'system' ? ' — change it for every canvas on the design system’s draft' : ''}
            </div>
            <MarkdownBlock>{doc.markdown}</MarkdownBlock>
            {error && <p className={errorText}>{error}</p>}
            <ModalActions>
              {origin !== 'system' && (
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  {origin === 'override' ? 'Reset to system' : 'Delete'}
                </Button>
              )}
              <ConfirmDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={origin === 'override' ? `Reset “${guideTitle(doc)}”?` : `Delete “${guideTitle(doc)}”?`}
                description={
                  origin === 'override'
                    ? `This canvas’s version goes and “${systemName}”’s shows again. Its history is kept.`
                    : 'Agents stop designing with this rule from their next task. Its version history is kept, so you can restore it later.'
                }
                confirmLabel={origin === 'override' ? 'Reset to system' : 'Delete guide'}
                destructive
                onConfirm={() => save(doc.name, '')}
              />
              <ModalSpacer />
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                Close
              </Button>
              {origin !== 'system' && (
                <Button variant="ghost" disabled={busy} onClick={() => setMode('history')}>
                  History
                </Button>
              )}
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setTitleDraft(guideTitle(doc))
                  setDraft(doc.markdown)
                  setError(null)
                  setMode('edit')
                }}
              >
                {origin === 'system' ? 'Override here' : 'Edit'}
              </Button>
            </ModalActions>
          </>
        )}
      </>
    </Modal>
  )
}

function GuideHistory({
  canvasId,
  doc,
  busy,
  onRestore,
  onBack,
}: {
  canvasId: string
  doc: GuidelineDoc
  busy: boolean
  onRestore: (markdown: string) => void
  onBack: () => void
}) {
  const [versions, setVersions] = useState<{ markdown: string; savedAt: number; savedBy: string }[] | null>(null)
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .guidelineHistory(canvasId, doc.name)
      .then((h) => alive && setVersions(h))
      .catch((e) => alive && setError(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : 'could not load history'))
    return () => {
      alive = false
    }
  }, [canvasId, doc.name])

  const preview = previewIdx !== null ? versions?.[previewIdx] : undefined

  return (
    <>
      <div className={modalHead}>
        <ModalTitle>{guideTitle(doc)} — history</ModalTitle>
      </div>
      {error && <p className={errorText}>{error}</p>}
      {preview ? (
        <>
          <div className={meta}>
            {preview.markdown ? 'saved' : 'deleted'} by {preview.savedBy} · {new Date(preview.savedAt).toLocaleString()}
          </div>
          {preview.markdown ? (
            <MarkdownBlock>{preview.markdown}</MarkdownBlock>
          ) : (
            <ModalLede>This version marks a deletion — there is nothing to show.</ModalLede>
          )}
          <ModalActions>
            <Button variant="ghost" disabled={busy} onClick={() => setPreviewIdx(null)}>
              Back
            </Button>
            <ModalSpacer />
            <Button
              variant="primary"
              disabled={busy || !preview.markdown || preview.markdown === doc.markdown}
              onClick={() => onRestore(preview.markdown)}
            >
              {busy ? 'Restoring…' : 'Restore this version'}
            </Button>
          </ModalActions>
        </>
      ) : (
        <>
          <div className="mt-3.5 overflow-hidden rounded-[12px] border border-line bg-surface">
            {versions?.length === 0 && <ModalLede>No versions recorded yet.</ModalLede>}
            {(versions ?? []).map((v, i) => (
              <ListRow
                key={v.savedAt + v.savedBy}
                className="border-b-0 border-t border-line-soft first:border-t-0"
                onClick={() => setPreviewIdx(i)}
              >
                <ListTitle>
                  {v.markdown === ''
                    ? 'deleted'
                    : v.markdown === doc.markdown
                      ? 'current'
                      : `v${(versions?.length ?? 0) - i}`}
                </ListTitle>
                <ListSummary>{v.markdown ? summarize(v.markdown) : '—'}</ListSummary>
                <ListMeta>
                  {v.savedBy} · {new Date(v.savedAt).toLocaleString()}
                </ListMeta>
              </ListRow>
            ))}
          </div>
          <ModalActions>
            <Button variant="ghost" disabled={busy} onClick={onBack}>
              Back
            </Button>
          </ModalActions>
        </>
      )}
    </>
  )
}
