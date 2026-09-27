/** Frames pushed in by the design-sync snippet carry a marker meta tag the
 *  ingest endpoint stamps into their HTML (server/ingest.ts). Its presence is
 *  the whole client-side signal — the key/page it encodes stays server-only. */
const SYNC_MARKER = 'name="draft-sync-page"'

export function isSyncedFrame(html: string): boolean {
  return html.includes(SYNC_MARKER)
}
