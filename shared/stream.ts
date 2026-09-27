/**
 * Streaming frames: a chunk can end anywhere, so what is shown mid-stream is
 * healed first. The server heals for reveal playback; clients heal the raw
 * text they accumulate from frame:append messages.
 */

/** Make partially-revealed HTML paint sensibly. */
export function healPartialHtml(html: string): string {
  // drop a trailing half-written tag: "<div cla"
  const lastOpen = html.lastIndexOf('<')
  if (lastOpen > html.lastIndexOf('>')) html = html.slice(0, lastOpen)
  const lower = html.toLowerCase()
  // drop an unclosed <script> entirely — never run half-written JS
  const scriptAt = lower.lastIndexOf('<script')
  if (scriptAt !== -1 && lower.indexOf('</script', scriptAt) === -1) html = html.slice(0, scriptAt)
  // close an unclosed <style> so everything after it renders
  const styleAt = html.toLowerCase().lastIndexOf('<style')
  if (styleAt !== -1 && html.toLowerCase().indexOf('</style', styleAt) === -1) html += '</style>'
  return html
}

const TAGS = ['<script', '</script', '<style', '</style'] as const
type Tag = (typeof TAGS)[number]

/** healPartialHtml for a text that only grows: O(chunk) per push, not O(text).
 *  Re-healing the whole accumulated stream per chunk made a long stream O(n²).
 *  Tracks where each script/style open and close starts, so a heal is a slice. */
export class StreamHealer {
  private raw = ''
  private lastLt = -1
  private lastGt = -1
  private at: Record<Tag, number[]> = { '<script': [], '</script': [], '<style': [], '</style': [] }

  constructor(initial = '') {
    if (initial) this.push(initial)
  }

  get length(): number {
    return this.raw.length
  }

  /** append a chunk and return the healed text so far */
  push(chunk: string): string {
    const from = Math.max(0, this.raw.length - 8) // a tag split across chunks
    this.raw += chunk
    const lt = chunk.lastIndexOf('<')
    if (lt !== -1) this.lastLt = this.raw.length - chunk.length + lt
    const gt = chunk.lastIndexOf('>')
    if (gt !== -1) this.lastGt = this.raw.length - chunk.length + gt
    const lower = this.raw.slice(from).toLowerCase()
    for (const tag of TAGS) {
      const list = this.at[tag]
      for (let i = lower.indexOf(tag); i !== -1; i = lower.indexOf(tag, i + 1)) {
        const abs = from + i
        if (abs > (list[list.length - 1] ?? -1)) list.push(abs)
      }
    }
    return this.healed()
  }

  private healed(): string {
    /* an unterminated tag at the end is cut; tags start with '<', so every
       tracked occurrence lies wholly before the cut or starts at it */
    let cut = this.lastLt > this.lastGt ? this.lastLt : this.raw.length
    const scriptAt = lastBefore(this.at['<script'], cut)
    if (scriptAt !== -1 && lastBefore(this.at['</script'], cut) < scriptAt) cut = scriptAt
    let html = this.raw.slice(0, cut)
    const styleAt = lastBefore(this.at['<style'], cut)
    if (styleAt !== -1 && lastBefore(this.at['</style'], cut) < styleAt) html += '</style>'
    return html
  }
}

function lastBefore(list: number[], limit: number): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]! < limit) return list[i]!
  return -1
}
