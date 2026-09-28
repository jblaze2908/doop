import { compileTheme } from '../../shared/theme'
import { runtimeDefs, type ComponentRuntimeDef } from '../../shared/components'
import { useStore } from './store'

/** The open canvas's compiled theme CSS. Stable per theme object, so an
 *  effect keyed on it re-posts only when the theme actually changes. */
export function useThemeCss(): string {
  return compileTheme(useStore((s) => s.canvas?.theme))
}

/** The same, minus @font-face: live frames get the faces as bytes instead
 *  (lib/frameFonts), fetched once by the page rather than once per iframe. */
export function useFrameThemeCss(): string {
  return compileTheme(
    useStore((s) => s.canvas?.theme),
    false,
  )
}

/** The canvas's Tailwind sheet ('' unless it opted in); frames place it after their own styles. */
export function useUtilityCss(): string {
  return useStore((s) => s.utilityCss)
}

/** The open canvas's component definitions as frame runtimes take them.
 *  runtimeDefs memoizes per definitions array, so this is stable until a
 *  definition changes. */
export function useComponentDefs(): ComponentRuntimeDef[] {
  return runtimeDefs(useStore((s) => s.canvas?.components))
}
