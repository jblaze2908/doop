import { useState } from 'react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { timeAgo } from '../lib/time'
import { posthog } from '../lib/posthog'
import { AgentIcon } from './AgentIcon'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Card } from './ui/card'
import { Dot } from './ui/dot'

/**
 * Board view over the canvas's tasks: queued cards humans leave for agents,
 * live work (agent status tasks), and what's done. Cards are plain AgentTask
 * objects, so everything updates over the same ws stream.
 */

/* class recipes shared across the board's cards and columns */
const colHeadCls = 'mb-3.5 flex items-baseline gap-2 border-b border-line pb-3'
const colHeadH2Cls = 'font-display text-[12px] font-[750] uppercase tracking-[0.14em]'
const countCls = 'font-mono text-[11px] text-ink-faint'
const cardBase = 'group relative px-4 py-3.5'
/* mirrors MAX_CARD_CHARS in server/actions.ts */
const MAX_CARD_CHARS = 4_000
const cardH3Cls =
  'line-clamp-8 break-words pr-4 font-display text-[14.5px] font-[650] leading-[1.35] tracking-[-0.01em]'
const metaCls =
  'mt-[9px] flex flex-wrap items-center gap-1.5 text-[12px] text-ink-faint [&_b]:font-[650] [&_b]:text-ink-soft'
/* the ✕ on a card: always reachable on touch, revealed on hover elsewhere */
const dismissCls =
  'absolute right-[9px] top-[9px] size-[22px] justify-center rounded-full p-0 text-xs opacity-100 hover:bg-paper-deep hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100'
const hintCls = 'text-[11.5px] text-ink-faint'

export function Board({ canvasId }: { canvasId: string }) {
  const tasks = useStore((s) => s.tasks)
  const [draft, setDraft] = useState<string | null>(null)

  const failed = tasks.filter((t) => t.queuedBy && t.failedAt && !t.endedAt)
  const queued = tasks.filter((t) => t.queuedBy && !t.agentName && !t.failedAt && !t.endedAt)
  const inProgress = tasks.filter((t) => t.agentName && !t.failedAt && !t.endedAt)
  const done = tasks.filter((t) => t.endedAt).slice(0, 14)

  async function submit() {
    const title = draft?.trim()
    setDraft(null)
    if (!title) return
    try {
      await api.addCard(canvasId, title)
      posthog.capture('agent_task_queued')
    } catch (err) {
      console.error(err)
    }
  }

  return (
    <div className="absolute inset-0 overflow-auto px-4 pb-[calc(120px+env(safe-area-inset-bottom))] pt-[22px] [background:radial-gradient(circle,var(--dot)_1px,transparent_1px)_0_0/26px_26px,var(--paper)] md:px-[34px] md:pb-[60px] md:pt-[30px]">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-7 md:min-w-max md:grid-cols-[repeat(3,minmax(280px,380px))] md:gap-[34px]">
        <section>
          <div className={colHeadCls}>
            <h2 className={cn(colHeadH2Cls, 'text-ink-soft')}>Queued</h2>
            <span className={countCls}>{queued.length + failed.length}</span>
          </div>
          <div className="flex flex-col gap-3">
            {failed.map((t) => (
              <Card
                key={t.id}
                className={cn(
                  cardBase,
                  'border-accent-ink/45 [background:linear-gradient(145deg,rgba(208,52,31,0.07),var(--surface)_62%)]',
                )}
              >
                <Button
                  variant="bare"
                  className={dismissCls}
                  aria-label="Remove this card"
                  title="Remove this card"
                  onClick={() => api.completeCard(canvasId, t.id).catch(console.error)}
                >
                  ✕
                </Button>
                <h3 className={cardH3Cls}>{t.status}</h3>
                <div className={metaCls}>
                  <b>Attempt stopped</b>
                  {t.agentName ? <span> · {t.agentName}</span> : null}
                  <span> · {timeAgo(t.failedAt!)}</span>
                </div>
                <div className="mt-[9px] text-[11.5px] leading-[1.4] text-accent-ink">
                  {t.failureReason ?? 'The agent did not finish this task.'}
                </div>
                <Button
                  variant="danger-solid"
                  size="pill"
                  className="mt-2.5 px-[11px] py-[5px]"
                  onClick={() => api.retryCard(canvasId, t.id).catch(console.error)}
                >
                  ↻ Retry
                </Button>
              </Card>
            ))}
            {queued.map((t) => (
              <Card key={t.id} className={cn(cardBase, 'bg-surface')}>
                <Button
                  variant="bare"
                  className={dismissCls}
                  title="Remove this card"
                  onClick={() => api.completeCard(canvasId, t.id).catch(console.error)}
                >
                  ✕
                </Button>
                <h3 className={cardH3Cls}>{t.status}</h3>
                <div className={metaCls}>
                  <b>{t.queuedBy}</b> · {timeAgo(t.startedAt)}
                </div>
                <div className="mt-[9px] font-mono text-[11px] text-ink-faint">✦ waiting for an agent</div>
              </Card>
            ))}
            {draft === null ? (
              <Button
                variant="ghost"
                className="justify-center rounded-[14px] border-[1.5px] border-dashed p-3.5 text-[13px] font-[650] text-ink-faint hover:border-brand hover:bg-transparent hover:text-accent-ink"
                onClick={() => setDraft('')}
              >
                + New card
              </Button>
            ) : (
              <Card className={cn(cardBase, 'bg-surface')}>
                <Textarea
                  autoFocus
                  variant="bare"
                  className="min-h-[54px] md:text-[13.5px]"
                  value={draft}
                  maxLength={MAX_CARD_CHARS}
                  placeholder="What should an agent work on?"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void submit()
                    }
                    if (e.key === 'Escape') setDraft(null)
                  }}
                />
                <div className="mt-3 flex flex-wrap items-center gap-2.5">
                  <Button
                    className="rounded-full border-transparent bg-ink px-3.5 py-1.5 text-xs font-bold text-white shadow-none hover:translate-x-0 hover:translate-y-0 hover:shadow-none"
                    disabled={!draft.trim()}
                    onClick={submit}
                  >
                    Queue it
                  </Button>
                  <span className={hintCls}>Waits on the board until you remove it</span>
                </div>
              </Card>
            )}
          </div>
        </section>

        <section>
          <div className={colHeadCls}>
            <h2 className={cn(colHeadH2Cls, 'text-accent-ink')}>In progress</h2>
            <span className={countCls}>{inProgress.length}</span>
          </div>
          <div className="flex flex-col gap-3">
            {inProgress.length === 0 && <div className="px-0.5 py-1 text-[13px] text-ink-faint">Nothing in flight</div>}
            {inProgress.map((t) => (
              <Card
                key={t.id}
                className={cn(cardBase, 'border-brand bg-surface shadow-[0_0_0_1px_var(--brand),var(--shadow-card)]')}
              >
                <h3 className={cardH3Cls}>{t.status}</h3>
                <div className={metaCls}>
                  <Dot
                    size="sm"
                    className="animate-[stream-pulse_1.2s_ease-in-out_infinite]"
                    style={{ background: t.color }}
                  />
                  <b className="inline-flex items-center gap-1">
                    <AgentIcon name={t.agentName} />
                    {t.agentName}
                  </b>
                  {t.owner && <span> · for {t.owner}</span>}
                  {t.queuedBy && <span> · card from {t.queuedBy}</span>}
                  <span> · {timeAgo(t.claimedAt ?? t.startedAt)}</span>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <section>
          <div className={colHeadCls}>
            <h2 className={cn(colHeadH2Cls, 'text-ink-soft')}>Done</h2>
            <span className={countCls}>{done.length}</span>
          </div>
          <div className="flex flex-col gap-3">
            {done.length === 0 && <div className="px-0.5 py-1 text-[13px] text-ink-faint">Nothing yet</div>}
            {done.map((t) => (
              <Card key={t.id} className={cn(cardBase, 'bg-transparent shadow-none')}>
                <h3 className="break-words pr-4 font-display text-[13.5px] font-semibold leading-[1.35] tracking-[-0.01em] text-ink-soft">
                  {t.status}
                </h3>
                <div className={metaCls}>
                  <span className="font-[750] text-[#1e7a4c]">✓</span> {t.agentName || t.queuedBy}
                  {t.queuedBy && t.agentName && <span> · for {t.queuedBy}</span>}
                  <span> · {timeAgo(t.endedAt!)}</span>
                </div>
              </Card>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
