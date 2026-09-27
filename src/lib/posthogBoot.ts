/* Session replay + exception capture + web vitals are compiled into our
   bundle (instead of posthog-js lazy-loading them from PostHog's CDN at
   runtime), and the no-external build guarantees nothing else is remotely
   loaded. Combined with the same-origin /relay proxy this makes analytics
   first-party end to end: there is no PostHog-owned URL for blockers to
   match, so replay works for effectively every user.

   posthog-recorder (not the legacy dist/recorder) is required: the SDK only
   starts replay when the entrypoint registers BOTH __PosthogExtensions__
   .rrweb and .initSessionRecording, and the legacy recorder lacks the
   latter — replay then waits on a lazy load that the no-external build can
   never perform and every session sticks at $recording_status
   "lazy_loading". */
import 'posthog-js/dist/posthog-recorder'
import 'posthog-js/dist/exception-autocapture'
import 'posthog-js/dist/web-vitals'
/* Conversations (customer support widget): also a lazy-loaded extension, so
   it must be compiled in or the no-external build can never show it. */
import 'posthog-js/dist/conversations'
import posthog from 'posthog-js/dist/module.no-external'
import { installFrameReplay } from './frameReplay'
import { desktopPlatform, isDesktopShell, shellVersion } from './shell'
import { NO_REPLAY_KEY } from './posthog'

/* Default to the same-origin relay (server/index.ts); VITE_POSTHOG_HOST is an
   escape hatch for pointing elsewhere, e.g. straight at PostHog in a dev
   setup without the API server. */
const host = import.meta.env.VITE_POSTHOG_HOST || `${location.origin}/relay`

/** Loaded lazily by ./posthog only when a key is configured — this module
 *  (the SDK, replay, exception capture) is the largest thing the app ships. */
export function boot(key: string) {
  installFrameReplay()
  posthog.init(key, {
    api_host: host,
    /* api_host is our relay; links out to the PostHog app must not be */
    ui_host: 'https://us.posthog.com',
    capture_pageview: 'history_change',
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    session_recording: {
      recordCrossOriginIframes: true,
      /* a design tool: what people type into prompts/comments is the point
         of watching a replay. Credentials stay masked. */
      maskAllInputs: false,
      maskInputOptions: { password: true, email: true },
    },
    disable_session_recording: localStorage.getItem(NO_REPLAY_KEY) === '1',
    defaults: '2026-05-30',
  })

  /* The desktop shell marks every page it loads (src/lib/shell.ts). Register
     the shell version and platform as super properties so every event and
     recording from the shell is segmentable in PostHog. The webview's
     storage is isolated from the user's browsers, so the flag can never
     leak onto ordinary web sessions. */
  if (isDesktopShell()) {
    posthog.register({
      desktop_app: true,
      desktop_app_version: shellVersion(),
      desktop_app_platform: desktopPlatform(),
    })
  }
  return posthog
}
