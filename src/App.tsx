import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { DESKTOP_HANDOFF_PATH, DESKTOP_SIGNIN_PATH } from './lib/desktopAuth'
import { authClient } from './lib/auth'
import { setName } from './lib/identity'
import { posthog, syncReplayForUser, suspendAnalyticsWhileImpersonating } from './lib/posthog'
import { useMe } from './lib/me'
import { adminApi } from './lib/api'
import { Button } from './components/ui/button'
import { AuthScreen } from './components/ui/screen'
import { DesktopTabs, ShellDragBar } from './components/DesktopTabs'
import { setTabsUser } from './lib/desktop'
import { isDesktopShell } from './lib/shell'

/* Every page is its own chunk: a visitor opening one canvas downloads the
   canvas page, not the dashboard and settings code too. */
const Home = lazy(() => import('./pages/Home').then((m) => ({ default: m.Home })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const loadCanvasPage = () => import('./pages/CanvasPage')
const CanvasPage = lazy(() => loadCanvasPage().then((m) => ({ default: m.CanvasPage })))
const AuthPage = lazy(() => import('./pages/AuthPage').then((m) => ({ default: m.AuthPage })))
const DesktopHandoff = lazy(() => import('./pages/DesktopHandoff').then((m) => ({ default: m.DesktopHandoff })))
const DesktopSignIn = lazy(() => import('./pages/DesktopSignIn').then((m) => ({ default: m.DesktopSignIn })))
const Workspace = lazy(() => import('./pages/Workspace').then((m) => ({ default: m.Workspace })))

/* the canvas is where almost every visit goes next: fetch it while idle */
if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void loadCanvasPage(), { timeout: 4000 })

export function navigate(path: string) {
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/* pages load as chunks; the blank shell is what the app showed before them anyway */
export function App() {
  return (
    <Suspense fallback={<div className="auth-page" />}>
      <Routes />
    </Suspense>
  )
}

function Routes() {
  const [path, setPath] = useState(location.pathname)
  const { data: session, isPending } = authClient.useSession()
  const me = useMe(session?.user.id)
  const identifiedUserId = useRef<string | null>(null)

  useEffect(() => {
    const onPop = () => setPath(location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /* The session is the auth boundary: this covers both successful login and
     restoring an existing session after a page refresh. */
  useEffect(() => {
    const user = session?.user
    if (!user) {
      if (identifiedUserId.current) {
        posthog.reset()
        identifiedUserId.current = null
      }
      return
    }
    /* Wait for /api/me before identifying anyone. Impersonation swaps the
       session cookie, so `user` here is the person being VIEWED — identifying
       them would write an admin's support session into that customer's
       profile and replay timeline. Only /api/me can tell the two apart. */
    if (!me) return
    if (me.impersonating) {
      suspendAnalyticsWhileImpersonating()
      identifiedUserId.current = null
      return
    }

    if (identifiedUserId.current === user.id) return
    if (identifiedUserId.current) posthog.reset()
    posthog.identify(user.id, { email: user.email, name: user.name })
    syncReplayForUser(user.email)
    identifiedUserId.current = user.id
  }, [session?.user, me])

  /* the account name is the identity shown on cursors and in the feed */
  useEffect(() => {
    if (session?.user?.name) setName(session.user.name)
  }, [session?.user?.name])

  /* the desktop tab strip is per-account state: restore this user's tabs,
     and clear the strip the moment the session goes away */
  useEffect(() => {
    if (!isPending) setTabsUser(session?.user?.id ?? null)
  }, [isPending, session?.user?.id])

  if (isPending)
    return (
      <>
        <ShellDragBar />
        <AuthScreen />
      </>
    )
  /* the desktop app sent this browser here to begin a provider sign-in on
     its behalf (src/lib/desktopAuth.ts) — signed in or not, the page itself
     decides where to go next */
  if (path === DESKTOP_SIGNIN_PATH)
    return (
      <>
        <ShellDragBar />
        <DesktopSignIn signedIn={!!session} />
      </>
    )

  /* signed out: every path lands on the sign-in form. The marketing site is
     a separate service (see server/marketing.ts) that owns `/` for
     visitors; share links (/c/…) and interrupted MCP OAuth redirects keep
     their URL so the deep link / resume logic survives the sign-in. */
  if (!session)
    return (
      <>
        <ShellDragBar />
        <AuthPage />
      </>
    )

  const canvasId = path.match(/^\/c\/([^/]+)/)?.[1]
  const page = canvasId ? (
    <CanvasPage canvasId={canvasId} key={canvasId} />
  ) : path === DESKTOP_HANDOFF_PATH ? (
    <DesktopHandoff />
  ) : path.startsWith('/settings') ? (
    <Settings />
  ) : path.match(/^\/w\/([^/]+)/) ? (
    <Workspace workspaceId={path.match(/^\/w\/([^/]+)/)![1]!} key={path} />
  ) : (
    <Home />
  )

  /* The banner is not decoration: an impersonated session looks exactly like
     being signed in as that person, and forgetting you are in one is how
     support tools cause incidents. */
  return me?.impersonating ? (
    <>
      <ImpersonationBanner name={session.user.name} />
      {/* --app-inset is the contract with fixed-position screens: the canvas
          workspace is `fixed inset-0` and ignores this padding, so it offsets
          itself by the same variable instead of hardcoding the banner height */}
      <div className="h-dvh overflow-auto pt-14 [--app-inset:56px] sm:pt-10 sm:[--app-inset:40px]">{page}</div>
    </>
  ) : isDesktopShell() ? (
    /* the desktop shell's tab strip uses the same --app-inset contract as
       the banner: fixed screens (the canvas workspace) offset themselves */
    <>
      <DesktopTabs path={path} />
      <div className="h-dvh overflow-auto pt-10 [--app-inset:40px]">{page}</div>
    </>
  ) : (
    page
  )
}

function ImpersonationBanner({ name }: { name: string }) {
  const [leaving, setLeaving] = useState(false)
  return (
    <div className="fixed inset-x-0 top-0 z-[900] flex min-h-14 items-center justify-between gap-2 border-b border-accent-ink px-2.5 py-[7px] text-[11.5px] leading-tight text-accent-ink backdrop-blur-[6px] [background:repeating-linear-gradient(-45deg,rgba(208,52,31,0.16)_0_10px,rgba(208,52,31,0.08)_10px_20px)] sm:h-10 sm:min-h-0 sm:justify-center sm:gap-4 sm:text-[13px]">
      <span>
        Viewing as <strong>{name}</strong> — read only, expires after 15 minutes.
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={leaving}
        onClick={() => {
          setLeaving(true)
          /* the cookie swaps back to the admin's own session; reload rather
             than reconcile every piece of per-user state in memory */
          const home = () => location.assign('/')
          adminApi.stopImpersonating().then(home, home)
        }}
      >
        {leaving ? 'Leaving…' : 'Stop viewing'}
      </Button>
    </div>
  )
}
