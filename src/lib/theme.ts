import { compileTheme } from '../../shared/theme'
import { runtimeDefs, type ComponentRuntimeDef } from '../../shared/components'
import { useStore } from './store'

/** The open canvas's compiled theme CSS. Stable per theme object, so an
 *  effect keyed on it re-posts only when the theme actually changes. */
export function useThemeCss(): string {
  return compileTheme(useStore((s) => s.canvas?.theme))
}

const EMPTY: ComponentRuntimeDef[] = []
const runtimeCache = new WeakMap<object, ComponentRuntimeDef[]>()

/** The open canvas's component definitions as frame runtimes take them.
 *  Stable per definitions array (the store replaces it on every change). */
export function useComponentDefs(): ComponentRuntimeDef[] {
  const defs = useStore((s) => s.canvas?.components)
  if (!defs?.length) return EMPTY
  let out = runtimeCache.get(defs)
  if (!out) {
    out = runtimeDefs(defs)
    runtimeCache.set(defs, out)
  }
  return out
}
