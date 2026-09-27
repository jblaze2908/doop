import type { PostHog } from 'posthog-js/dist/module.no-external'

/* The analytics facade every module imports. The SDK (with session replay,
   exception capture and web vitals compiled in, see ./posthogBoot) is by far
   the largest thing the app ships, so it is loaded with a dynamic import
   only when a key is configured, once the page is idle. Calls made before
   then are queued; without a key they are dropped and the SDK is never
   downloaded. */

const key: string | undefined = import.meta.env.VITE_POSTHOG_KEY

/* Accounts on "internal" email domains are excluded from session replay:
   the operators' own usage would drown out real-user recordings. Domains
   come from VITE_POSTHOG_INTERNAL_DOMAINS (comma-separated, inlined at
   build time); unset = no exclusions. The runtime stop covers the session
   where the login happens; the persisted flag keeps replay from even
   starting on that browser's next load. */
const INTERNAL_DOMAINS: string[] = (import.meta.env.VITE_POSTHOG_INTERNAL_DOMAINS || '')
  .split(',')
  .map((d: string) => d.trim().toLowerCase())
  .filter(Boolean)
const isInternalEmail = (email: string) => INTERNAL_DOMAINS.some((d) => email.toLowerCase().endsWith(`@${d}`))
export const NO_REPLAY_KEY = 'draft:internal-no-replay'

type Call = (ph: PostHog) => void
const MAX_QUEUED = 500
let real: PostHog | null = null
const queue: Call[] = []

function run(call: Call) {
  if (!key) return
  if (real) call(real)
  else if (queue.length < MAX_QUEUED) queue.push(call)
}

type Props = Record<string, unknown>

export const posthog = {
  capture: (event: string, props?: Props) => run((ph) => void ph.capture(event, props)),
  identify: (id: string, props?: Props) => run((ph) => ph.identify(id, props)),
  register: (props: Props) => run((ph) => ph.register(props)),
  reset: () => run((ph) => ph.reset()),
  startSessionRecording: () => run((ph) => ph.startSessionRecording()),
  stopSessionRecording: () => run((ph) => ph.stopSessionRecording()),
}

if (!key) {
  /* Both keys are inlined at build time, so a build that never saw them ships
     an app with analytics silently off. Warn rather than throw: a missing key
     must not white-screen a fresh clone that hasn't copied .env.example yet. */
  console.warn('VITE_POSTHOG_KEY is unset — PostHog is disabled and no events will be sent.')
} else {
  const start = () =>
    import('./posthogBoot')
      .then(({ boot }) => {
        real = boot(key)
        for (const call of queue.splice(0)) call(real)
      })
      .catch((err) => console.error('analytics failed to load', err))
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 3000 })
  else setTimeout(start, 1)
}

/** Call on every identify: stops replay for internal accounts, (re)starts it
 *  when a non-internal account signs in on a browser previously flagged. */
export function syncReplayForUser(email: string | null | undefined) {
  if (!key || !email) return
  if (isInternalEmail(email)) {
    localStorage.setItem(NO_REPLAY_KEY, '1')
    posthog.stopSessionRecording()
  } else {
    localStorage.removeItem(NO_REPLAY_KEY)
    /* explicit start overrides disable_session_recording from init */
    posthog.startSessionRecording()
  }
}

/** An admin viewing as another user. Their navigation must not be written to
 *  the customer's PostHog profile, and must not be recorded at all.
 *
 *  Deliberately does NOT go through syncReplayForUser: that function keys the
 *  persisted NO_REPLAY_KEY flag off the account email, so a borrowed email
 *  would rewrite whose browser this is — an internal operator viewing as an
 *  external user would clear their own exclusion and keep recording after the
 *  support session ended. */
export function suspendAnalyticsWhileImpersonating() {
  if (!key) return
  posthog.reset() // subsequent events are anonymous, not the customer's
  posthog.stopSessionRecording()
}
