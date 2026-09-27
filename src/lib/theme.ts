import { compileTheme } from '../../shared/theme'
import { runtimeDefs, type ComponentRuntimeDef } from '../../shared/components'
import { useStore } from './store'

/** The open canvas's compiled theme CSS. Stable per theme object, so an
 *  effect keyed on it re-posts only when the theme actually changes. */
export function useThemeCss(): string {
  return compileTheme(useStore((s) => s.canvas?.theme))
}

/** The open canvas's component definitions as frame runtimes take them.
 *  runtimeDefs memoizes per definitions array, so this is stable until a
 *  definition changes. */
export function useComponentDefs(): ComponentRuntimeDef[] {
  return runtimeDefs(useStore((s) => s.canvas?.components))
}
