/**
 * Refero Styles extractor — local test for the inspo pipeline (roadmap 12a/20).
 *
 * Queries styles.refero.design for a category, then for each result saves the
 * best still image (full-page screenshot when present; otherwise the preview
 * video's poster, which is its first frame served as a jpg) plus a recipe.json
 * with the pre-distilled style facts (northStar mood line, named palette,
 * fonts, color scheme, source URL).
 *
 * Usage: npx tsx scripts/refero-extract.ts "law firm" [count=5] [outdir=./data/inspo]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const API = 'https://styles.refero.design/api/styles'
const UA = { 'user-agent': 'Mozilla/5.0 (draft inspo test)' }

type Style = {
  id: string
  url: string
  siteName: string
  screenshotUrl: string | null
  thumbnailUrl: string | null
  previewVideoDetailUrl: string | null
  previewVideoDetailPosterUrl: string | null
  previewVideoUrl: string | null
  previewVideoPosterUrl: string | null
  colorScheme: string | null
  colors: { name: string; hex: string }[]
  fonts: string[]
  northStar: string | null
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

async function download(url: string, to: string) {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`${res.status} on ${url}`)
  writeFileSync(to, Buffer.from(await res.arrayBuffer()))
}

async function main() {
  const [query, countArg, outArg] = process.argv.slice(2)
  if (!query) {
    console.error('usage: refero-extract.ts "<query>" [count] [outdir]')
    process.exit(1)
  }
  const count = Number(countArg || 5)
  const outdir = join(outArg || './data/inspo', slug(query))
  mkdirSync(outdir, { recursive: true })

  const res = await fetch(`${API}/search?q=${encodeURIComponent(query)}`, { headers: UA })
  if (!res.ok) throw new Error(`search failed: ${res.status}`)
  const { styles } = (await res.json()) as { styles: Style[] }
  console.log(`"${query}": ${styles.length} styles, taking ${Math.min(count, styles.length)} → ${outdir}`)

  for (const s of styles.slice(0, count)) {
    const base = join(outdir, `${slug(s.siteName)}--${s.id.slice(0, 8)}`)
    const poster = s.previewVideoDetailPosterUrl ?? s.previewVideoPosterUrl
    let image: string
    let source: string

    try {
      if (s.screenshotUrl) {
        image = `${base}.jpg`
        await download(s.screenshotUrl, image)
        source = 'screenshot'
      } else if (poster) {
        /* the poster IS the video's first frame, served as a jpg */
        image = `${base}.poster.jpg`
        await download(poster, image)
        source = 'video poster'
      } else {
        console.warn(`  ✗ ${s.siteName}: no media`)
        continue
      }
    } catch (e) {
      console.warn(`  ✗ ${s.siteName}: ${(e as Error).message}`)
      continue
    }

    const recipe = {
      id: s.id,
      site: s.siteName,
      sourceUrl: s.url,
      referoUrl: `https://styles.refero.design/style/${s.id}`,
      northStar: s.northStar,
      colorScheme: s.colorScheme,
      palette: s.colors,
      fonts: s.fonts,
      media: { file: image, source, video: s.previewVideoDetailUrl ?? s.previewVideoUrl ?? undefined },
    }
    writeFileSync(`${base}.json`, JSON.stringify(recipe, null, 2))
    console.log(`  ✓ ${s.siteName} (${source}) — "${s.northStar ?? 'no north star'}"`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
