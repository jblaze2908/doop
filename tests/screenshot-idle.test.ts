import { describe, expect, it, vi } from 'vitest'

/* A short idle window so the test sees the browser exit; real Chromium, skipped where none is installed */
vi.stubEnv('DRAFT_BROWSER_IDLE_MS', '300')
const screenshot = await import('../server/screenshot.ts')
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!screenshot.findBrowserPath())('idle Chromium', () => {
  it('exits after the last page closes and relaunches on the next render', async () => {
    const first = await screenshot.openIsolatedPage()
    const browser = await screenshot.getBrowser()
    await wait(500)
    expect(browser.connected, 'an open page keeps it alive').toBe(true)

    await first.close()
    await wait(700)
    expect(browser.connected).toBe(false)

    const next = await screenshot.openIsolatedPage()
    const relaunched = await screenshot.getBrowser()
    expect(relaunched).not.toBe(browser)
    expect(relaunched.connected).toBe(true)
    await next.close()
    await relaunched.close()
  }, 30_000)
})
