import { compileTheme, type CanvasTheme } from '../../shared/theme'
import { mergeComponents, mergeTheme } from '../../shared/designSystem'
import { runtimeDefs, type ComponentDef, type ComponentRuntimeDef } from '../../shared/components'
import { useStore } from './store'

/** The open canvas's compiled theme CSS. Stable per theme object, so an
 *  effect keyed on it re-posts only when the theme actually changes. */
/** The canvas's effective theme: its design system's version under its own. */
export function useEffectiveTheme(): CanvasTheme | undefined {
  return mergeTheme(
    useStore((s) => s.system?.snapshot.theme),
    useStore((s) => s.canvas?.theme),
  )
}

/** The canvas's effective components: the system's, overridden by name by its own. */
export function useEffectiveComponents(): ComponentDef[] {
  return mergeComponents(
    useStore((s) => s.system?.snapshot.components),
    useStore((s) => s.canvas?.components),
  )
}

export function useThemeCss(): string {
  return compileTheme(useEffectiveTheme())
}

/** The same, minus @font-face: live frames get the faces as bytes instead
 *  (lib/frameFonts), fetched once by the page rather than once per iframe. */
export function useFrameThemeCss(): string {
  return compileTheme(useEffectiveTheme(), false)
}

/** The canvas's Tailwind sheet ('' unless it opted in); frames place it after their own styles. */
export function useUtilityCss(): string {
  return useStore((s) => s.utilityCss)
}

/** The open canvas's component definitions as frame runtimes take them.
 *  runtimeDefs memoizes per definitions array, so this is stable until a
 *  definition changes. */
export function useComponentDefs(): ComponentRuntimeDef[] {
  return runtimeDefs(useEffectiveComponents())
}
