import { useSyncExternalStore } from 'react'

/* A per-browser viewer preference, not account data. index.html applies the
   stored choice before first paint (keep its key and rule in step with this). */
export type ColorScheme = 'system' | 'light' | 'dark'

const KEY = 'draft-color-scheme'
/* absent under jsdom and node, where tests import this module */
const media =
  typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : undefined
const listeners = new Set<() => void>()

function read(): ColorScheme {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

let current = read()

function apply() {
  const dark = current === 'dark' || (current === 'system' && !!media?.matches)
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('dark', dark)
}

function changed() {
  apply()
  for (const listener of listeners) listener()
}

export function isColorScheme(value: string): value is ColorScheme {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function getColorScheme(): ColorScheme {
  return current
}

export function setColorScheme(next: ColorScheme) {
  current = next
  try {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    /* storage blocked: the choice holds for this tab only */
  }
  changed()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, getColorScheme)
}

/* "system" tracks the OS live, and a choice made in another tab lands here too */
media?.addEventListener('change', () => current === 'system' && apply())
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    current = read()
    changed()
  })
}
apply()
