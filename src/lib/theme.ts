import { compileTheme } from '../../shared/theme'
import { useStore } from './store'

/** The open canvas's compiled theme CSS. Stable per theme object, so an
 *  effect keyed on it re-posts only when the theme actually changes. */
export function useThemeCss(): string {
  return compileTheme(useStore((s) => s.canvas?.theme))
}
