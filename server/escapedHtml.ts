/**
 * Agents sometimes send HTML-escaped markup (`&lt;!doctype html&gt;…`) where raw
 * tags belong. Stored verbatim, the frame renders those entities as text and the
 * human watches the design's own source code appear on the canvas.
 *
 * A document that carries escaped tags and not one raw `<` has no elements at
 * all, so it can only be a mis-encoded write — decode it rather than render
 * source. Anything holding real markup is left untouched, which keeps escaped
 * code samples inside a genuine design safe.
 */

/* a tag opener admits no space after the `<`, which keeps prose like
   "widths under &lt; 600px" out of the match */
const ESCAPED_TAG = /&(?:lt|#0*60|#[xX]0*3[cC]);[/!a-zA-Z]/

/** True only for a payload that is markup, but entirely escaped. */
export function looksEscapedHtml(html: string): boolean {
  return !html.includes('<') && ESCAPED_TAG.test(html)
}

/** Reverse one level of HTML escaping. `&amp;` goes last so `&amp;lt;` → `&lt;`. */
export function decodeEscapedHtml(html: string): string {
  return html
    .replace(/&(?:lt|#0*60|#[xX]0*3[cC]);/g, '<')
    .replace(/&(?:gt|#0*62|#[xX]0*3[eE]);/g, '>')
    .replace(/&(?:quot|#0*34|#[xX]0*22);/g, '"')
    .replace(/&(?:apos|#0*39|#[xX]0*27);/g, "'")
    .replace(/&(?:amp|#0*38|#[xX]0*26);/g, '&')
}

export function repairEscapedHtml(html: string): string {
  return looksEscapedHtml(html) ? decodeEscapedHtml(html) : html
}

/** Told to the agent whenever a write was repaired, so it stops escaping. */
export const ESCAPED_HTML_NOTE =
  'That HTML arrived escaped (&lt;div&gt; where <div> belongs), which renders as visible source text on the canvas. Draft decoded it so the frame still shows a design — send raw markup from here on: these tools take HTML exactly as written, no escaping.'
