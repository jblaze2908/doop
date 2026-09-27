import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { frameById, useStore } from '../lib/store'
import type { Frame } from '../../shared/types'
import { useShallow } from 'zustand/react/shallow'
import { connect, disconnect, sendWs } from '../lib/ws'
import { api, ApiError, type DiscoveredSite, type SyncKeyInfo } from '../lib/api'
import { navigate } from '../App'
import { BarDivider, TopBar, TopBarHome, TopBarTitle } from '../components/TopBar'
import { ensureTab } from '../lib/desktop'
import { Stage } from '../components/Stage'
import { ActivityPanel } from '../components/ActivityPanel'
import { WorkingNow } from '../components/WorkingNow'
import { SideRail } from '../components/SideRail'
import { LayersPanel, LayersRailToggle } from '../components/LayersPanel'
import { getIdentity, setName } from '../lib/identity'
import {
  copyFrames,
  duplicateFrames,
  hasFrameClip,
  pasteFrameCentered,
  pasteImagesCentered,
} from '../lib/frameClipboard'
import { clearHistory, onHistoryConflict, recordCreate, redo, undo } from '../lib/history'
import { deleteSelection } from '../lib/layerEdits'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { useIsMobile } from '../hooks/use-mobile'
import { cn } from '@/lib/utils'
import { Button } from '../components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../components/ui/sheet'
import { AuthScreen } from '../components/ui/screen'
import { Wordmark } from '../components/ui/wordmark'
import { BrainIcon, ImportIcon, MoreHorizontalIcon, PlayIcon, PulseIcon, SparkIcon } from '../components/ui/icons'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Field } from '../components/ui/field'
import { Avatar } from '../components/ui/avatar'
import { PeerAvatars } from '../components/PeerAvatars'
import { Checkbox, CheckboxCard } from '../components/ui/checkbox'
import { Segmented, SegmentedItem } from '../components/ui/segmented'
import { Toast, ToastAction } from '../components/ui/toast'
import { Tooltip } from '../components/ui/tooltip'
import { Note } from '../components/ui/note'
import { Textarea } from '../components/ui/textarea'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from '../components/ui/modal'

/* not needed for a canvas's first paint: loaded when first shown */
const Board = lazy(() => import('../components/Board').then((m) => ({ default: m.Board })))
const Inspector = lazy(() => import('../components/Inspector').then((m) => ({ default: m.Inspector })))
const ElementPanel = lazy(() => import('../components/ElementPanel').then((m) => ({ default: m.ElementPanel })))
const Onboarding = lazy(() => import('../components/Onboarding').then((m) => ({ default: m.Onboarding })))
const ConnectModal = lazy(() => import('../components/ConnectModal').then((m) => ({ default: m.ConnectModal })))
const ShareModal = lazy(() => import('../components/ShareModal').then((m) => ({ default: m.ShareModal })))
const PresentMode = lazy(() => import('../components/PresentMode').then((m) => ({ default: m.PresentMode })))

const STARTER_HTML = `<!doctype html>
<html>
<head>
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, sans-serif;
    height: 100vh;
    display: grid;
    place-items: center;
    background: #fafafa;
    color: #999;
  }
</style>
</head>
<body>
  <p>Design me — edit the HTML, or ask an agent.</p>
</body>
</html>`

/* Small captions the import flow repeats under its fields. */
const importNoteCls = 'mt-2.5 text-[11.5px] leading-[1.4] text-ink-faint'
const errorNoteCls = 'mt-2.5 text-[13px] text-accent-ink'

export function CanvasPage({ canvasId }: { canvasId: string }) {
  const connected = useStore((s) => s.connected)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const isMobile = useIsMobile()
  const [showActivity, setShowActivity] = useState(() => !window.matchMedia('(max-width: 900px)').matches)
  const [view, setView] = useState<'canvas' | 'board'>('canvas')
  const [showConnect, setShowConnect] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [presenting, setPresenting] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showMobileActions, setShowMobileActions] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const updateReady = useStore((s) => s.updateReady)
  const canvasNotFound = useStore((s) => s.canvasNotFound)

  /* keep the desktop shell's tab label in step with the live canvas name.
     The store's canvas briefly lags a navigation (the previous page's data
     until this one's ws init lands), so only sync when it's really ours —
     otherwise closing a tab re-adds it from its own stale state. */
  const liveName = useStore((s) => (s.canvas?.id === canvasId ? s.canvas.name : undefined))
  useEffect(() => {
    if (liveName !== undefined) ensureTab(canvasId, liveName)
  }, [liveName, canvasId])

  useEffect(() => {
    connect(canvasId)
    return () => {
      disconnect()
      useStore.getState().setCanvas(null)
      useStore.getState().setPresences([])
      useStore.getState().setCanvasNotFound(false)
      select(null)
      clearHistory()
    }
  }, [canvasId, select])

  /* broadcast which frame I'm focused on */
  useEffect(() => {
    sendWs({ type: 'editing', frameId: selectedId })
  }, [selectedId])

  /* frame keyboard shortcuts: delete, copy/paste/duplicate, undo/redo */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const selectedIds = useStore.getState().selectedIds
      /* a picked element (from the canvas or the layers tree) is what ⌫
         removes — the frame it lives in only goes when nothing inside it is
         selected. Auto-repeat is ignored: a held key must not take the
         element and then, on the next repeat, the frame under it. */
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.repeat && deleteSelection()) e.preventDefault()
      if (e.key === 'Escape') {
        select(null)
        useStore.getState().setFollowing(null)
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) void redo()
        else void undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        void redo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        /* ⌘C and ⌘D act on the whole selection */
        const frames = useStore.getState().canvas?.frames.filter((f) => selectedIds.includes(f.id)) ?? []
        /* don't hijack ⌘C when the user is copying selected text */
        if (e.key === 'c' && frames.length && !window.getSelection()?.toString()) copyFrames(frames)
        if (e.key === 'd' && frames.length) {
          e.preventDefault()
          duplicateFrames(frames)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canvasId]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ⌘V lands here as a real paste event: clipboard images upload and drop in
     as frames; otherwise a copied frame (⌘C) pastes centered. Handled on
     'paste' rather than keydown so the browser hands us the clipboard bytes
     without a permission prompt. */
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (images.length) {
        e.preventDefault()
        pasteImagesCentered(canvasId, images).catch((err: Error) => {
          setToast(`Couldn’t paste image — ${err.message}`)
          window.setTimeout(() => setToast(null), 4000)
        })
      } else if (hasFrameClip()) {
        e.preventDefault()
        pasteFrameCentered(canvasId)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [canvasId])

  function showToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2000)
  }
  useEffect(
    () =>
      onHistoryConflict((msg) => {
        setToast(msg)
        window.setTimeout(() => setToast(null), 3000)
      }),
    [],
  )

  /* a decision landing in Memory is invisible work — surface it as a memory
     toast in the top-right stack. Only decisions captured after this page
     loaded count, so the ws-init batch stays silent. */
  const latestDecision = useStore((s) => s.decisions[0])
  const [decisionToast, setDecisionToast] = useState<string | null>(null)
  const loadedAt = useRef(0)
  const decisionToastTimer = useRef<number | null>(null)
  useEffect(() => {
    if (!loadedAt.current) loadedAt.current = Date.now()
    if (latestDecision && latestDecision.at > loadedAt.current) {
      const line = latestDecision.summary ?? latestDecision.text
      setDecisionToast(line.length > 64 ? line.slice(0, 61) + '…' : line)
      if (decisionToastTimer.current) window.clearTimeout(decisionToastTimer.current)
      decisionToastTimer.current = window.setTimeout(() => setDecisionToast(null), 6000)
    }
  }, [latestDecision])

  async function addFrame() {
    const n = (useStore.getState().canvas?.frames.length ?? 0) + 1
    const frame = await api.createFrame(canvasId, { name: `Frame ${n}`, html: STARTER_HTML })
    posthog.capture('frame_created')
    recordCreate(frame)
    select(frame.id)
  }

  const me = getIdentity()
  const others = useStore(useShallow((s) => Object.values(s.presences).filter((p) => p.clientId !== me.clientId)))

  /* existence only: the panels subscribe to the frame itself (SelectedFrame) */
  const hasSelectedFrame = useStore((s) => !!frameById(s, s.selectedId))
  /* the share modal is the one consumer of the whole canvas; only while open */
  const shareCanvas = useStore((s) => (showShare ? s.canvas : null))
  /* the panel only shows when a frame-name click (or deep link) opened it —
     selecting a frame by clicking its surface must not slide it in */
  const inspectorOpen = useStore((s) => s.inspectorOpen)
  /* a right-click that selected the frame keeps the Inspector out until the
     context menu closes — it would slide in right under the open menu */
  const deferPanel = useStore((s) => !!s.ctxMenu?.deferPanel)
  const layersOpen = useStore((s) => s.layersOpen)
  /* the element panel takes the frame inspector's spot while a Layers row
     has it open; it follows the element selection until it is closed */
  const selectedElement = useStore((s) => s.selectedElement)
  const elementPanelOpen = useStore((s) => s.elementPanelOpen)
  const panelElement =
    elementPanelOpen && hasSelectedFrame && selectedElement?.frameId === selectedId ? selectedElement : null
  /* both right-hand property panels sit beside the Activity panel when it is
     open, beside the collapsed side rail otherwise */
  const propertiesPanelCls = showActivity ? 'right-[324px]' : 'right-[72px]'

  /* the id in the URL isn't a canvas — a typo, a stale link, or one someone
     just deleted. Say so plainly rather than opening a canvas shell that
     can't load anything and never will. */
  if (canvasNotFound) {
    return (
      <AuthScreen>
        <div className="flex w-[min(400px,100%)] flex-col gap-3.5 rounded-[12px] border border-line bg-surface p-6 pt-[30px] text-center shadow-pop sm:p-9 sm:pb-7">
          <Wordmark className="mb-1.5 self-center" />
          <h1 className="font-serif text-[28px] font-normal leading-[1.05] tracking-[-0.015em]">Canvas not found</h1>
          <p className="text-[14px] leading-[1.5] text-ink-soft">
            &ldquo;{canvasId}&rdquo; doesn&rsquo;t match a canvas we know about. It may have been deleted, or the link
            may be wrong.
          </p>
          <Button className="self-center" onClick={() => navigate('/')}>
            Back to your canvases
          </Button>
        </div>
      </AuthScreen>
    )
  }

  return (
    /* --app-inset is 0 normally; the impersonation shell raises it so this
       fixed layer starts below the banner instead of under it */
    <div className="fixed inset-x-0 bottom-0 top-[var(--app-inset,0px)] flex flex-col">
      {/* Three tiers. Desktop (≥ md): one row with the full action set. Tablet
          (xs..md): still one row — the id badge and the text actions fold
          into the ••• sheet so the name and the view switch keep their room.
          Phone (< xs): two rows, the name on top, the switch and the actions
          below it, each at its natural width. */}
      <TopBar>
        <div className="flex min-w-0 items-center gap-1.5 max-xs:basis-full">
          <TopBarHome label="All canvases" to="/" />
          <CanvasName />
          <Badge className="max-md:hidden" title="Canvas id — agents use this with the MCP tools">
            {canvasId}
          </Badge>
          {!connected && (
            <Badge tone="accent" className="max-md:ml-auto">
              reconnecting…
            </Badge>
          )}
        </div>
        <Segmented
          className="shrink-0 max-xs:order-2"
          aria-label="View"
          value={view}
          onValueChange={(next) => setView(next as 'canvas' | 'board')}
        >
          <SegmentedItem value="canvas">Canvas</SegmentedItem>
          <SegmentedItem value="board">Board</SegmentedItem>
        </Segmented>
        <div className="ml-auto flex items-center gap-2.5 max-md:hidden">
          <Button
            variant="bare"
            className="h-8 px-2.5 text-[12.5px] font-medium"
            onClick={() => setShowImport(true)}
            title="Import a live web page as a frame"
          >
            <ImportIcon className="size-[13px]" />
            Import
          </Button>
          <BarDivider />
          <div className="flex items-center px-0.5" title={others.map((p) => p.name).join(', ') || 'Just you here'}>
            <Button
              variant="bare"
              className="p-0 hover:bg-transparent"
              title={`You are “${me.name}” — click to change your name`}
              onClick={() => setRenaming(true)}
            >
              <Avatar name={me.name} kind="user" stacked />
            </Button>
            <PeerAvatars others={others} />
          </div>
          <BarDivider />
          <Tooltip label={selectedId ? 'Present this frame' : 'Select a frame to present'} side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className="size-[34px] rounded-[7px] bg-surface hover:border-ink-faint hover:bg-paper-deep disabled:opacity-40"
              aria-label="Present selected frame"
              disabled={!selectedId}
              onClick={() => setPresenting(true)}
            >
              <PlayIcon className="size-3.5" />
            </Button>
          </Tooltip>
          <Button
            variant="ghost"
            className="h-[34px] rounded-[7px] bg-surface px-[17px] text-[12.5px] font-semibold hover:border-ink-faint hover:bg-paper-deep"
            onClick={() => setShowShare(true)}
          >
            Share
          </Button>
          <Button
            variant="primary"
            className="h-[34px] rounded-[7px] px-[13px] text-[12.5px]"
            onClick={() => {
              posthog.capture('agent_connection_opened')
              setShowConnect(true)
            }}
          >
            <SparkIcon className="size-3" />
            Connect AI
          </Button>
        </div>
        <div className="ml-auto hidden items-center gap-1.5 max-md:flex max-xs:order-3">
          <div
            className="mr-1 flex items-center max-sm:hidden"
            title={others.map((p) => p.name).join(', ') || 'Just you here'}
          >
            <Avatar name={me.name} kind="user" stacked />
            <PeerAvatars others={others} />
          </div>
          <Button
            variant="primary"
            className="h-[34px] rounded-[7px] px-[13px] text-[12.5px]"
            onClick={() => {
              posthog.capture('agent_connection_opened')
              setShowConnect(true)
            }}
          >
            <SparkIcon className="size-3" />
            <span className="max-sm:hidden">Connect AI</span>
            <span className="sm:hidden">AI</span>
          </Button>
          <Tooltip label="Canvas actions" side="bottom" align="end">
            <Button
              variant="ghost"
              size="icon"
              className="size-[34px] rounded-[7px] bg-surface"
              aria-label="Canvas actions"
              onClick={() => setShowMobileActions(true)}
            >
              <MoreHorizontalIcon />
            </Button>
          </Tooltip>
        </div>
      </TopBar>

      <div className="relative flex-1 overflow-hidden">
        {view === 'board' ? (
          <Suspense fallback={null}>
            <Board canvasId={canvasId} />
          </Suspense>
        ) : (
          <>
            <Stage onAddFrame={addFrame} />
            <div
              className={cn(
                'pointer-events-none absolute top-3 right-[72px] z-30 flex flex-col items-end gap-2 transition-[right] duration-150 ease-[ease] [&>*]:pointer-events-auto max-md:top-[56px] max-md:right-2 max-md:left-2',
                /* clear of the 300px side panel at right: 12px */
                showActivity && 'right-[324px]',
              )}
            >
              {decisionToast && (
                <Button
                  variant="ghost"
                  className="max-w-full items-center gap-2.5 whitespace-normal rounded-[12px] border-line bg-surface px-3.5 py-2.5 text-left shadow-pop transition-shadow hover:bg-surface hover:shadow-card sm:max-w-[320px] [&_svg]:text-accent-ink"
                  title="Open Memory"
                  onClick={() => {
                    useStore.getState().setPanelTab('memory')
                    setShowActivity(true)
                    setDecisionToast(null)
                  }}
                >
                  <BrainIcon width={17} height={17} />
                  <span>
                    <b className="block font-display text-[13px] font-semibold tracking-[-0.01em]">Saved to Memory</b>
                    <span className="mt-[1px] block text-[12px] leading-[1.4] text-ink-soft">{decisionToast}</span>
                  </span>
                </Button>
              )}
            </div>
            <WorkingNow />
            <Suspense fallback={null}>
              <Onboarding />
            </Suspense>
            {!isMobile && (layersOpen ? <LayersPanel onAddFrame={addFrame} /> : <LayersRailToggle />)}
            {!isMobile && hasSelectedFrame && panelElement && !deferPanel && (
              <Suspense fallback={null}>
                <SelectedFrame>
                  {(frame) => (
                    <ElementPanel
                      key={`${frame.id}|${panelElement.selector}`}
                      frame={frame}
                      selector={panelElement.selector}
                      className={propertiesPanelCls}
                    />
                  )}
                </SelectedFrame>
              </Suspense>
            )}
            {!isMobile && hasSelectedFrame && inspectorOpen && !panelElement && !deferPanel && (
              <Suspense fallback={null}>
                <SelectedFrame>{(frame) => <Inspector frame={frame} className={propertiesPanelCls} />}</SelectedFrame>
              </Suspense>
            )}
            {!isMobile && !showActivity && <SideRail onOpen={() => setShowActivity(true)} />}
            {!isMobile && showActivity && <ActivityPanel onClose={() => setShowActivity(false)} />}
          </>
        )}
      </div>

      {isMobile && (
        <>
          <Sheet open={showMobileActions} onOpenChange={setShowMobileActions}>
            <SheetContent
              side="bottom"
              className="gap-0 rounded-t-2xl border-line bg-surface p-0 pb-[env(safe-area-inset-bottom)] shadow-pop"
            >
              <div className="border-b border-line-soft px-5 py-4 pr-14">
                <SheetTitle className="font-display text-lg font-extrabold">Canvas actions</SheetTitle>
                <SheetDescription className="mt-1 text-xs text-ink-soft">
                  Import, share, or change your account settings.
                </SheetDescription>
              </div>
              <div className="grid gap-2 p-4">
                <Button
                  variant="ghost"
                  className="h-11 justify-start border-line bg-surface px-4"
                  onClick={() => {
                    setShowMobileActions(false)
                    setShowImport(true)
                  }}
                >
                  ⤓ Import website
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 justify-start border-line bg-surface px-4"
                  onClick={() => {
                    setShowMobileActions(false)
                    setShowShare(true)
                  }}
                >
                  Share canvas
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 justify-start border-line bg-surface px-4"
                  onClick={() => {
                    setShowMobileActions(false)
                    setShowActivity(true)
                  }}
                >
                  <PulseIcon /> Agents & activity
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 justify-start px-4 text-ink-soft"
                  onClick={() => navigate('/settings')}
                >
                  Settings
                </Button>
              </div>
            </SheetContent>
          </Sheet>
          <Sheet
            open={hasSelectedFrame && inspectorOpen && !deferPanel}
            onOpenChange={(open) => {
              if (!open) select(null)
            }}
          >
            <SheetContent
              side="bottom"
              showCloseButton={false}
              className="max-h-[calc(100svh-56px)] gap-0 rounded-t-2xl border-line bg-surface p-0 shadow-pop data-[side=bottom]:h-[min(78svh,680px)]"
            >
              <SheetTitle className="sr-only">Frame inspector</SheetTitle>
              {hasSelectedFrame && (
                <Suspense fallback={null}>
                  <SelectedFrame>{(frame) => <Inspector frame={frame} surface="inline" />}</SelectedFrame>
                </Suspense>
              )}
            </SheetContent>
          </Sheet>
          <Sheet open={showActivity} onOpenChange={setShowActivity}>
            <SheetContent
              side="bottom"
              showCloseButton={false}
              className="max-h-[calc(100svh-56px)] gap-0 rounded-t-2xl border-line bg-surface p-0 shadow-pop data-[side=bottom]:h-[min(78svh,680px)]"
            >
              <SheetTitle className="sr-only">Canvas activity</SheetTitle>
              <ActivityPanel onClose={() => setShowActivity(false)} surface="inline" />
            </SheetContent>
          </Sheet>
        </>
      )}

      {renaming && <RenameSelfModal current={me.name} onClose={() => setRenaming(false)} />}
      {showConnect && (
        <Suspense fallback={null}>
          <ConnectModal canvasId={canvasId} onClose={() => setShowConnect(false)} />
        </Suspense>
      )}
      {presenting && selectedId && (
        <Suspense fallback={null}>
          <PresentMode frameId={selectedId} onClose={() => setPresenting(false)} />
        </Suspense>
      )}
      {shareCanvas && (
        <Suspense fallback={null}>
          <ShareModal
            key={shareCanvas.id}
            canvas={shareCanvas}
            onChange={(patch) => {
              const current = useStore.getState().canvas
              if (current?.id === canvasId) useStore.getState().setCanvas({ ...current, ...patch })
            }}
            onClose={() => setShowShare(false)}
            onCopied={() => {
              setShowShare(false)
              showToast('Canvas link copied')
            }}
          />
        </Suspense>
      )}
      {showImport && (
        <ImportModal
          canvasId={canvasId}
          onClose={() => setShowImport(false)}
          onDone={(frameIds, failedCount) => {
            setShowImport(false)
            setView('canvas')
            select(frameIds[0] ?? null)
            const imported = frameIds.length === 1 ? '1 item imported' : `${frameIds.length} items imported`
            showToast(failedCount ? `${imported} · ${failedCount} failed` : imported)
          }}
        />
      )}
      {updateReady ? (
        <Toast>
          draft was updated
          <ToastAction onClick={() => location.reload()}>Reload</ToastAction>
        </Toast>
      ) : (
        toast && <Toast>{toast}</Toast>
      )}
    </div>
  )
}

function ImportModal({
  canvasId,
  onClose,
  onDone,
}: {
  canvasId: string
  onClose: () => void
  onDone: (frameIds: string[], failedCount: number) => void
}) {
  const [url, setUrl] = useState('')
  const [wholeSite, setWholeSite] = useState(false)
  const [discovery, setDiscovery] = useState<DiscoveredSite | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'discovering' | 'importing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  function errorMessage(caught: unknown, fallback: string) {
    if (caught instanceof ApiError) return String(caught.body.error ?? fallback)
    return caught instanceof Error ? caught.message.replace(/^\d+\s*/, '') : fallback
  }

  function normalizedUrl() {
    const clean = url.trim()
    return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
  }

  async function runSinglePage() {
    if (!url.trim() || busy) return
    setBusy('importing')
    setError(null)
    try {
      const frame = await api.importPage(canvasId, normalizedUrl())
      posthog.capture('page_imported')
      onDone([frame.id], 0)
    } catch (e) {
      setError(errorMessage(e, 'import failed'))
      setBusy(null)
    }
  }

  async function discover() {
    if (!url.trim() || busy) return
    setBusy('discovering')
    setError(null)
    try {
      const found = await api.discoverSitePages(canvasId, normalizedUrl())
      setDiscovery(found)
      setSelected(new Set(found.pages.map((page) => page.url)))
      posthog.capture('site_pages_discovered', { page_count: found.pages.length, truncated: found.truncated })
      setBusy(null)
    } catch (e) {
      setError(errorMessage(e, 'page discovery failed'))
      setBusy(null)
    }
  }

  async function importSelected() {
    if (!discovery || !selected.size || busy) return
    setBusy('importing')
    setError(null)
    const urls = discovery.pages.filter((page) => selected.has(page.url)).map((page) => page.url)
    try {
      const result = await api.importSitePages(canvasId, urls)
      if (!result.frames.length) {
        const reason = result.failures[0]?.error
        setError(reason ? `No pages could be imported — ${reason}` : 'No pages could be imported')
        setBusy(null)
        return
      }
      posthog.capture('website_imported', {
        requested_count: urls.length,
        imported_count: result.frames.length,
        failed_count: result.failures.length,
      })
      onDone(
        result.frames.map((frame) => frame.id),
        result.failures.length,
      )
    } catch (e) {
      setError(errorMessage(e, 'website import failed'))
      setBusy(null)
    }
  }

  function togglePage(pageUrl: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(pageUrl)) next.delete(pageUrl)
      else next.add(pageUrl)
      return next
    })
  }

  const selectedCount = selected.size

  return (
    <Modal size="lg" onClose={() => !busy && onClose()}>
      <>
        {!discovery ? (
          <>
            <div className="flex flex-col gap-[5px]">
              <ModalEyebrow>Website capture</ModalEyebrow>
              <ModalTitle>Import from the web</ModalTitle>
            </div>
            <ModalLede>
              Bring in one page, or discover a whole site and choose the pages you want before anything is added.
            </ModalLede>
            <Field className="mt-[22px]" label="Website URL" labelVariant="form" htmlFor="import-url">
              <Input
                id="import-url"
                variant="mono"
                inputSize="lg"
                className="bg-paper focus:border-ink focus:bg-white focus:ring-0"
                autoFocus
                placeholder="https://example.com"
                value={url}
                disabled={!!busy}
                onChange={(e) => {
                  setUrl(e.target.value)
                  setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (wholeSite) void discover()
                    else void runSinglePage()
                  }
                  if (e.key === 'Escape' && !busy) onClose()
                }}
              />
            </Field>
            <CheckboxCard
              checked={wholeSite}
              disabled={!!busy}
              onChange={(next) => {
                setWholeSite(next)
                setError(null)
              }}
              title={
                <>
                  Import the entire website{' '}
                  <em className="ml-[7px] rounded-full bg-paper-deep px-1.5 py-[2px] font-mono text-[8.5px] font-semibold uppercase not-italic tracking-[0.08em] text-ink-faint">
                    Optional
                  </em>
                </>
              }
              description="Find public pages on the same site, then review the list."
            />
            <p className={importNoteCls}>Snapshots stay editable and commentable. Scripts are removed.</p>
            {error && <p className={errorNoteCls}>{error}</p>}
            <ModalActions>
              <Button variant="ghost" disabled={!!busy} onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!!busy || !url.trim()} onClick={wholeSite ? discover : runSinglePage}>
                {busy === 'discovering'
                  ? 'Finding pages…'
                  : busy === 'importing'
                    ? 'Importing…'
                    : wholeSite
                      ? 'Find pages →'
                      : '⤓ Import page'}
              </Button>
            </ModalActions>
            <SyncKeysSection canvasId={canvasId} />
          </>
        ) : (
          <>
            <div className="flex flex-col items-start justify-between gap-2.5 sm:flex-row sm:gap-6">
              <div className="flex flex-col gap-[5px]">
                <ModalEyebrow>Review before import</ModalEyebrow>
                <ModalTitle>Choose pages</ModalTitle>
              </div>
              <Badge className="max-w-full overflow-hidden text-ellipsis rounded-full bg-paper px-[9px] py-[5px] text-[10.5px] sm:max-w-[240px]">
                {new URL(discovery.siteUrl).hostname}
              </Badge>
            </div>
            <ModalLede>
              {discovery.pages.length} {discovery.pages.length === 1 ? 'page' : 'pages'} found. Everything is selected
              by default; uncheck anything you don’t need.
            </ModalLede>
            <div className="mt-5 flex items-center justify-between px-[2px] pb-[9px]">
              <b className="text-[12px] text-ink-soft">
                {selectedCount} of {discovery.pages.length} selected
              </b>
              <span className="flex gap-3">
                <Button
                  variant="bare"
                  size="sm"
                  className="p-0 font-mono text-[10.5px] hover:bg-transparent hover:text-accent-ink"
                  disabled={!!busy}
                  onClick={() => setSelected(new Set(discovery.pages.map((p) => p.url)))}
                >
                  Select all
                </Button>
                <Button
                  variant="bare"
                  size="sm"
                  className="p-0 font-mono text-[10.5px] hover:bg-transparent hover:text-accent-ink"
                  disabled={!!busy}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </Button>
              </span>
            </div>
            <div
              className={cn(
                'max-h-[calc(100dvh-390px)] overflow-y-auto rounded-[11px] border border-line bg-paper transition-opacity sm:max-h-[min(350px,calc(100vh-390px))]',
                busy && 'opacity-[0.58]',
              )}
              role="group"
              aria-label="Pages to import"
            >
              {discovery.pages.map((page, index) => {
                const pageUrl = new URL(page.url)
                let pathname = pageUrl.pathname
                try {
                  pathname = decodeURIComponent(pathname)
                } catch {
                  /* Keep the encoded path when a site contains a malformed escape. */
                }
                const path = pathname + pageUrl.search
                return (
                  <label
                    className="relative grid min-h-[58px] cursor-pointer grid-cols-[20px_24px_minmax(0,1fr)] items-center gap-2.5 border-b border-line bg-surface px-3 py-[9px] first:rounded-t-[10px] last:rounded-t-none last:rounded-b-[10px] last:border-b-0 hover:bg-[#fbfbfc]"
                    key={page.url}
                  >
                    <Checkbox
                      checked={selected.has(page.url)}
                      disabled={!!busy}
                      onChange={() => togglePage(page.url)}
                    />
                    <span className="font-mono text-[9.5px] text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                    <span className="min-w-0">
                      <b className="block overflow-hidden whitespace-nowrap text-ellipsis text-[12.5px] text-ink">
                        {page.title}
                      </b>
                      <span className="mt-[3px] block overflow-hidden whitespace-nowrap text-ellipsis font-mono text-[10px] text-ink-faint">
                        {path || '/'}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
            {discovery.truncated && (
              <p className={importNoteCls}>Showing the first 100 pages found. Narrow the starting URL if needed.</p>
            )}
            {busy === 'importing' && (
              <p className={cn(importNoteCls, 'text-accent-ink')}>
                Capturing {selectedCount} pages — larger sites can take a few minutes.
              </p>
            )}
            {error && <p className={errorNoteCls}>{error}</p>}
            <ModalActions className="justify-between">
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  setDiscovery(null)
                  setError(null)
                }}
              >
                ← Back
              </Button>
              <Button variant="primary" disabled={!!busy || !selectedCount} onClick={importSelected}>
                {busy === 'importing'
                  ? `Importing ${selectedCount}…`
                  : `⤓ Import ${selectedCount} ${selectedCount === 1 ? 'page' : 'pages'}`}
              </Button>
            </ModalActions>
          </>
        )}
      </>
    </Modal>
  )
}

/** Your display name, the identity on your cursor and in the feed. It lives on
 *  the account, so saving it updates the account and rejoins the canvas. */
function RenameSelfModal({ current, onClose }: { current: string; onClose: () => void }) {
  const [draft, setDraft] = useState(current)
  const [busy, setBusy] = useState(false)
  const clean = draft.trim()

  function save() {
    if (!clean || clean === current || busy) return onClose()
    setBusy(true)
    authClient.updateUser({ name: clean }).then(
      () => {
        setName(clean)
        location.reload()
      },
      (err: unknown) => {
        console.error(err)
        setBusy(false)
      },
    )
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalTitle>Your display name</ModalTitle>
        <ModalLede>Shown on your cursor, in the activity feed, and on everything you leave for an agent.</ModalLede>
        <Field className="mt-5" label="Name" labelVariant="form" htmlFor="display-name">
          <Input
            id="display-name"
            autoFocus
            value={draft}
            maxLength={60}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </Field>
        <ModalActions>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !clean || clean === current} onClick={save}>
            {busy ? 'Saving…' : 'Save name'}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}

/* Design sync: mint write-only snippet keys so an app pushes its live screens
   onto this canvas — the import path for products behind SSO/VPN where the
   server-side importer can't go. */
function SyncKeysSection({ canvasId }: { canvasId: string }) {
  const [keys, setKeys] = useState<SyncKeyInfo[] | null>(null)
  const [name, setAppName] = useState('')
  const [busy, setBusy] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  /* keys are owner/member-only (durable access) — link-edit visitors get a
     403 and shouldn't see the section at all */
  const [forbidden, setForbidden] = useState(false)

  useEffect(() => {
    api
      .listSyncKeys(canvasId)
      .then(setKeys)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true)
        setKeys([])
      })
  }, [canvasId])

  /* key in the src query string — the one attribute tag managers never strip */
  const snippetFor = (secret: string) =>
    `<script async src="${location.origin}/draft-sync.js?key=${secret}"></` + `script>`

  async function create() {
    if (busy || !name.trim()) return
    setBusy(true)
    try {
      const key = await api.createSyncKey(canvasId, name.trim())
      setKeys((k) => [key, ...(k ?? [])])
      setAppName('')
      posthog.capture('sync_key_created')
    } catch (e) {
      console.error(e)
    }
    setBusy(false)
  }

  function revoke(keyId: string) {
    api.deleteSyncKey(canvasId, keyId).catch(console.error)
    setKeys((k) => k?.filter((x) => x.id !== keyId) ?? null)
  }

  async function copySnippet(key: SyncKeyInfo) {
    await navigator.clipboard.writeText(snippetFor(key.secret))
    setCopiedId(key.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  if (forbidden) return null
  return (
    <div className="mt-3.5 flex flex-col gap-2.5 border-t border-line-soft pt-3.5">
      <h3 className="text-[13px] font-semibold text-ink">Or sync a live app</h3>
      <Note>
        For apps a crawler can't reach — behind a login, a VPN, or on localhost. Paste one script tag and each screen
        people visit lands here as a frame, imported once. Delete a frame to re-import it fresh. The key only writes to
        this canvas.
      </Note>
      {(keys ?? []).map((k) => (
        <div key={k.id} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[13px]">
            <b className="font-semibold">{k.name}</b>
            <Note className="mr-auto">
              {k.frames ? `${k.frames} screen${k.frames === 1 ? '' : 's'}` : k.lastUsedAt ? 'synced' : 'never synced'}
            </Note>
            <Button
              variant="bare"
              size="icon-sm"
              className="-mr-1.5 text-[13px] hover:bg-accent-ink/10 hover:text-accent-ink"
              title="Revoke this key"
              onClick={() => revoke(k.id)}
            >
              ✕
            </Button>
          </div>
          <div className="relative">
            <Textarea
              className="resize-none border-line-soft bg-black/[0.04] py-2 pl-2.5 pr-[84px] font-mono text-[11px] leading-normal text-ink-faint focus:border-line focus:text-ink focus:ring-0 md:text-[11px] [word-break:break-all]"
              readOnly
              rows={4}
              value={snippetFor(k.secret)}
              onFocus={(e) => e.target.select()}
            />
            <Button
              size="sm"
              className="absolute right-3.5 top-3 bg-surface px-2.5 text-xs"
              onClick={() => copySnippet(k)}
            >
              {copiedId === k.id ? 'Copied!' : '⧉ Copy'}
            </Button>
          </div>
        </div>
      ))}
      <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row">
        <Input
          className="flex-1 rounded-[10px] bg-paper focus:ring-0"
          placeholder="App name (e.g. Admin dashboard)"
          value={name}
          disabled={busy}
          onChange={(e) => setAppName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <Button variant="primary" className="justify-center" disabled={busy || !name.trim()} onClick={create}>
          Create key
        </Button>
      </div>
    </div>
  )
}

/* The selected frame, subscribed here rather than in CanvasPage, so its edits
   and drags re-render the property panel, not the whole page. */
function SelectedFrame({ children }: { children: (frame: Frame) => ReactNode }) {
  const frame = useStore((s) => frameById(s, s.selectedId))
  return frame ? children(frame) : null
}

/* The canvas title doubles as its rename field. */
function CanvasName() {
  const id = useStore((s) => s.canvas?.id)
  const name = useStore((s) => s.canvas?.name)
  return (
    <TopBarTitle
      loading={id === undefined}
      value={name ?? ''}
      onCommit={(name) => {
        if (!id) return
        api.renameCanvas(id, name).catch(console.error)
        useStore.getState().renameCanvasLocal(name)
      }}
    />
  )
}
