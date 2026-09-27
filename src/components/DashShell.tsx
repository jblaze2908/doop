import { useState } from 'react'
import { authClient } from '../lib/auth'
import { navigate } from '../App'
import { posthog } from '../lib/posthog'
import { useMe } from '../lib/me'
import { isDesktopShell } from '../lib/shell'
import { isColorScheme, setColorScheme, useColorScheme } from '../lib/colorScheme'
import { AgentIcon } from './AgentIcon'
import { ConnectModal } from './ConnectModal'
import { CodeBlock } from './ui/code-block'
import { Button } from './ui/button'
import { Segmented, SegmentedItem } from './ui/segmented'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import {
  BuildingIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GearIcon,
  GridIcon,
  HelpIcon,
  ListIcon,
  LogOutIcon,
  UserIcon,
  UsersIcon,
} from './ui/icons'

/** Pieces the signed-in shell repeats on every page: the account menu in the
 *  top bar and the connect card pinned to the bottom of the rail. They live
 *  here so Home and Settings cannot drift apart. */

export function initials(name?: string): string {
  const [first, ...rest] = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!first) return '·'
  const last = rest[rest.length - 1]
  const letters = last ? first.slice(0, 1) + last.slice(0, 1) : first.slice(0, 2)
  return letters.toUpperCase()
}

export function AccountMenu() {
  const { data: session } = authClient.useSession()
  const me = useMe(session?.user.id)
  const scheme = useColorScheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="bare"
          className="grid size-10 flex-none place-items-center rounded-[10px] bg-ink font-display text-[12.5px] font-bold text-on-ink hover:bg-ink hover:text-on-ink hover:opacity-90 sm:size-[34px]"
          aria-label="Account"
        >
          {initials(session?.user.name)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel className="flex items-center gap-[11px] px-2.5 pb-3 pt-[11px]">
          <span className="grid size-[42px] flex-none place-items-center rounded-[12px] border border-line bg-paper-deep font-display text-[14px] font-extrabold">
            {initials(session?.user.name)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-display text-[14px] font-bold">{session?.user.name}</span>
            <span className="mt-px truncate text-[12px] font-normal text-ink-faint">
              {me?.email ?? session?.user.email}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <IconGear /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="https://github.com/jblaze2908/doop#readme" target="_blank" rel="noopener noreferrer">
            <IconHelp /> Help &amp; docs
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* not a menu item, so picking a scheme previews it without closing the menu */}
        <div className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-[13px]">
          Theme
          <Segmented
            aria-label="Theme"
            value={scheme}
            onValueChange={(value) => isColorScheme(value) && setColorScheme(value)}
          >
            <SegmentedItem value="system">Auto</SegmentedItem>
            <SegmentedItem value="light">Light</SegmentedItem>
            <SegmentedItem value="dark">Dark</SegmentedItem>
          </Segmented>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          tone="danger"
          onSelect={() =>
            authClient.signOut().then(() => {
              posthog.reset()
              /* the shell has no marketing site: a signed-out reload of /
                 would show the landing page, so it goes to the sign-in form
                 the shell opens on (main.rs) */
              if (isDesktopShell()) location.assign('/auth')
              else location.reload()
            })
          }
        >
          <IconOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The rail's bottom slot. Same card on every page — the quick command for the
 *  common case, and the full per-client instructions a click away. */
export function ConnectCard() {
  const [showConnect, setShowConnect] = useState(false)
  return (
    <>
      <div className="rounded-[12px] border border-dashed border-line px-[13px] py-3">
        <b className="block font-display text-[12.5px]">Connect an agent</b>
        <p className="mt-[3px] text-[11.5px] leading-[1.45] text-ink-faint">
          Any MCP client — one command, one browser approval.
        </p>
        <span className="mt-[9px] flex items-center gap-2">
          <AgentIcon name="claude" size={14} />
          <AgentIcon name="codex" size={14} color="var(--ink)" />
          <em className="text-[10.5px] not-italic text-ink-faint">+ any MCP</em>
        </span>
        <CodeBlock
          density="rail"
          className="mt-2"
          text={`claude mcp add --transport http draft "${location.origin}/mcp"`}
        />
        <Button
          variant="link"
          size="sm"
          className="mt-[9px] px-0 py-0 text-[11.5px] text-accent-ink underline-offset-[3px]"
          onClick={() => setShowConnect(true)}
        >
          Codex &amp; other clients →
        </Button>
      </div>
      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
    </>
  )
}

/* ---- icons ----
   The shell's nav glyphs, at the rail's 15px, drawn from the shared set. */

const rail = { width: 15, height: 15, 'aria-hidden': true } as const

export const IconGrid = () => <GridIcon {...rail} />
export const IconList = () => <ListIcon {...rail} />
export const IconUser = () => <UserIcon {...rail} />
export const IconShare = () => <UsersIcon {...rail} />
/** a shared workspace — the org's building */
export const IconWorkspace = () => <BuildingIcon {...rail} />
export const IconGear = () => <GearIcon {...rail} />
export const IconHelp = () => <HelpIcon {...rail} />
export const IconOut = () => <LogOutIcon {...rail} />
export const IconBack = () => <ChevronLeftIcon width={14} height={14} aria-hidden />
export const IconChevron = () => <ChevronRightIcon width={12} height={12} aria-hidden />
