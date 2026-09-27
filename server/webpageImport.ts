import type { Actor, Frame } from '../shared/types.ts'
import * as actions from './actions.ts'
import { importPage, type ImportedPage } from './importer.ts'

interface WebpageImportDependencies {
  importPage: typeof importPage
  createFrame: typeof actions.createFrame
}

const dependencies: WebpageImportDependencies = {
  importPage,
  createFrame: actions.createFrame,
}

export interface ImportedWebpageFrame {
  imported: ImportedPage
  frame: Frame | undefined
}

/** Agent-facing wrapper around the browser/UI importer: the page-to-frame
 *  mapping connected agents get through import_webpage. Dependencies are injectable for a
 *  bounded unit test without launching Chrome or writing to the store. */
export async function createImportedWebpageFrame(
  input: {
    canvasId: string
    url: string
    actor: Actor
    includePreview?: boolean
  },
  deps: WebpageImportDependencies = dependencies,
): Promise<ImportedWebpageFrame> {
  const imported = await deps.importPage(input.url, { includePreview: input.includePreview })
  const frame = deps.createFrame(
    input.canvasId,
    {
      name: imported.title.slice(0, 80),
      width: imported.width,
      height: imported.height,
      html: imported.html,
    },
    input.actor,
  )
  return { imported, frame }
}
