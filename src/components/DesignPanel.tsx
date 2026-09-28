import { useStore } from '../lib/store'
import { PanelBody } from './ui/panel'
import { DesignSystemSection } from './DesignSystemSection'
import { ThemeSection } from './ThemeSection'
import { ComponentsSection } from './ComponentsSection'
import { RulesSection } from './RulesSection'

/** The Design tab in the side panel: the design system this canvas uses (or
 *  drafts), then the theme, components and rules every frame renders with. */
export function DesignPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  if (!canvasId) return null
  return (
    <PanelBody className="flex flex-col py-2">
      <DesignSystemSection canvasId={canvasId} />
      <ThemeSection canvasId={canvasId} />
      <ComponentsSection canvasId={canvasId} />
      <RulesSection canvasId={canvasId} />
    </PanelBody>
  )
}
