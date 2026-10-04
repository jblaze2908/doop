import { api } from './api'
import { useStore } from './store'

export interface CheckRule {
  id: string
  name: string
  category: 'slop' | 'quality'
  description: string
}

/** Run the design check on a frame; the result also reaches every viewer over the socket. */
export async function runDesignCheck(frameId: string) {
  const s = useStore.getState()
  if (s.checks[frameId] === 'running') return
  s.setCheck(frameId, 'running')
  try {
    useStore.getState().upsertAudit(await api.auditFrame(frameId))
    useStore.getState().setCheck(frameId, null)
  } catch (e) {
    console.error(e)
    useStore.getState().setCheck(frameId, 'failed')
  }
}

/* 21 KB of rule names and descriptions: its own chunk, fetched when a check is first opened */
let catalog: Promise<Map<string, CheckRule>> | undefined
export function loadCheckRules(): Promise<Map<string, CheckRule>> {
  catalog ??= import('../../server/vendor/impeccable/antipatterns.json').then(
    (m) => new Map((m.default as CheckRule[]).map((r) => [r.id, r])),
  )
  return catalog
}
