import { navigate } from '../App'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { openCanvasTab } from '../lib/desktop'
import { AccountSettings } from '../components/AccountSettings'
import { AccountMenu, ConnectCard, IconBack, IconChevron, IconUser } from '../components/DashShell'
import { Button } from '../components/ui/button'
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

/**
 * Account settings. It wears the same shell as the home dashboard: same rail,
 * same top bar, same account menu. Only the rail's middle changes, to a
 * settings sub-nav.
 */
export function Settings() {
  async function createCanvas() {
    const canvas = await api.createCanvas('Untitled canvas')
    posthog.capture('canvas_created')
    if (!openCanvasTab(canvas.id, canvas.name)) navigate(`/c/${canvas.id}`)
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

        <DashSectionLabel>Settings</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <DashNavItem icon={<IconUser />} active>
            Your account
          </DashNavItem>
        </nav>

        <div className="min-h-6 flex-1" />
        <ConnectCard />
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
            <b className="font-semibold text-ink">Settings</b>
          </nav>
          <span className="flex-1" />
          <Button variant="primary" className="min-h-10 max-xs:px-3 md:min-h-0" onClick={createCanvas}>
            <span className="max-xs:hidden">+ New canvas</span>
            <span className="hidden max-xs:inline">+ New</span>
          </Button>
          <AccountMenu />
        </DashHeader>

        <DashContent>
          <div className="flex items-start gap-4 md:items-end">
            <div>
              <DashTitle>Your account</DashTitle>
              <DashSubtitle>Who you are on every canvas — and how you get back into this one.</DashSubtitle>
            </div>
          </div>
          <AccountSettings />
        </DashContent>
      </DashMain>
    </DashLayout>
  )
}
