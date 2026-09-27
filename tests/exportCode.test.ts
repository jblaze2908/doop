import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportFrameCode } from '../server/exportCode.ts'
import { decodeEntities, jsxAttrName, jsxStyle, jsxText, scopeComponentCss } from '../server/jsx.ts'
import type { ComponentDef } from '../shared/components.ts'
import type { Canvas, Frame } from '../shared/types.ts'

const ROOT = process.cwd()

describe('jsx building blocks', () => {
  it('maps attribute names, dropping inline handlers', () => {
    expect(['class', 'for', 'stroke-width', 'viewbox', 'aria-label', 'data-x', 'onclick'].map(jsxAttrName)).toEqual([
      'className',
      'htmlFor',
      'strokeWidth',
      'viewBox',
      'aria-label',
      'data-x',
      null,
    ])
  })

  it('turns inline styles into objects, keeping custom properties and semicolons inside url()', () => {
    expect(jsxStyle('color: var(--ink); --gap: 4px; -webkit-font-smoothing: antialiased; background:url(a;b)')).toBe(
      '{{ color: "var(--ink)", "--gap": "4px", WebkitFontSmoothing: "antialiased", background: "url(a;b)" }}',
    )
  })

  it('keeps HTML whitespace semantics in JSX text', () => {
    expect([jsxText('\n   '), jsxText('Hi'), jsxText(' spaced  out '), jsxText('{x}'), jsxText('a &amp; b')]).toEqual([
      "{' '}",
      'Hi',
      '{" spaced out "}',
      '{"{x}"}',
      '{"a & b"}',
    ])
    expect(decodeEntities('&copy; &#8377; &#x2192; &bogus;')).toBe('© ₹ → &bogus;')
  })

  it('scopes shadow CSS to the wrapper class', () => {
    expect(
      scopeComponentCss(':host{display:grid} :host([tone="loss"]) b{color:red} i, ::slotted(em){x:1}', 'ds-x', [
        'tone',
      ]),
    ).toBe('.ds-x{display:inline}\n.ds-x{display:grid}.ds-x[data-tone="loss"] b{color:red}.ds-x i, .ds-x em{x:1}')
  })
})

const def = (over: Partial<ComponentDef>): ComponentDef => ({
  name: 'ds-x',
  html: '<slot></slot>',
  css: '',
  props: [],
  version: 1,
  updatedAt: 0,
  updatedBy: 't',
  ...over,
})

const CARD = def({
  name: 'ds-card',
  description: 'A card',
  html: '<div class="card card--{{tone}}"><slot name="icon"><i>•</i></slot><h3>{{title}}</h3><p><slot></slot></p><ds-pill>{{tone}}</ds-pill></div>',
  css: ':host{display:block} :host([tone="loss"]) h3{color:red}',
  props: [{ name: 'title' }, { name: 'tone', default: 'plain' }],
})
const PILL = def({ name: 'ds-pill', html: '<b><slot></slot></b>', css: ':host{display:inline-block}' })

function canvasWith(html: string): { frame: Frame; canvas: Canvas } {
  const frame: Frame = {
    id: 'f',
    canvasId: 'c',
    name: 'Home page',
    html,
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 't',
  }
  const canvas: Canvas = {
    id: 'c',
    name: 'C',
    createdAt: 0,
    updatedAt: 0,
    frames: [frame],
    theme: {
      tokens: [{ name: '--ink', type: 'color', value: '#111' }],
      css: '.card{padding:8px}',
      fonts: [],
      fontFaces: '',
      version: 1,
      updatedAt: 0,
      updatedBy: 't',
    },
    components: [CARD, PILL, def({ name: 'ds-gone', deletedAt: 1 })],
  }
  return { frame, canvas }
}

const FRAME = `<!doctype html><html><head><link rel="stylesheet" href="https://fonts.example/a.css"><style>ds-card .x{margin:0} .hero > ds-card{gap:1px}</style></head>
<body><section class="hero" onclick="go()">
  <ds-card title="Net worth" tone="loss" class="wide"><svg slot="icon" viewbox="0 0 4 4"><lineargradient id="g"></lineargradient><path stroke-width="2" d="M0 0"></path></svg>₹18,42,300</ds-card>
  <label for="e">Email</label><input id="e" value="a@b.c" disabled><textarea>Hi &amp; bye</textarea>
  <p style="--gap: 2px; color: var(--ink)">Spaced  text</p>
  <model-viewer></model-viewer>
  <script>alert(1)</script>
</section></body></html>`

describe('exportFrameCode', () => {
  it('writes a page, the components it uses (transitively), and the theme', () => {
    const { frame, canvas } = canvasWith(FRAME)
    const out = exportFrameCode(frame, canvas, 'react')
    expect(out.entry).toBe('HomePage.tsx')
    expect(out.files.map((f) => f.path)).toEqual([
      'styles/tokens.css',
      'styles/theme.css',
      'components/DsCard.tsx',
      'components/DsCard.css',
      'components/DsPill.tsx',
      'components/DsPill.css',
      'HomePage.css',
      'HomePage.tsx',
    ])
    const file = (p: string) => out.files.find((f) => f.path === p)!.content
    const page = file('HomePage.tsx')
    expect(page).toContain(
      '<DsCard title="Net worth" tone="loss" className="wide" icon={<svg viewBox="0 0 4 4"><linearGradient id="g" /><path strokeWidth="2" d="M0 0" /></svg>}>₹18,42,300</DsCard>',
    )
    expect(page).toContain('<input id="e" defaultValue="a@b.c" disabled />')
    expect(page).toContain('<textarea defaultValue="Hi & bye" />')
    expect(page).toContain('style={{ "--gap": "2px", color: "var(--ink)" } as CSSProperties}')
    expect(page).toContain('as CSSProperties}>Spaced text</p>')
    expect(page).not.toMatch(/onClick|alert|<script/)
    expect(file('HomePage.css')).toContain('@import url("https://fonts.example/a.css");')
    expect(file('HomePage.css')).toContain(
      '@import url("https://fonts.example/a.css");\n.ds-card .x{margin:0}.hero > .ds-card{gap:1px}',
    )
    const card = file('components/DsCard.tsx')
    expect(card).toContain('className={`card card--${(tone ?? "plain")}`}')
    expect(card).toContain('{icon ?? <><i>•</i></>}')
    expect(card).toContain('data-tone={tone}')
    expect(card).toContain("import { DsPill } from './DsPill'")
    expect(file('components/DsCard.css')).toContain('.ds-card[data-tone="loss"] h3{color:red}')
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/event handler onclick/),
        expect.stringMatching(/<model-viewer> is not a linked component/),
        expect.stringMatching(/dropped <script>/),
      ]),
    )
  })

  it('compiles under strict TypeScript with React types', () => {
    const { frame, canvas } = canvasWith(FRAME)
    const out = exportFrameCode(frame, canvas, 'react')
    const dir = mkdtempSync(path.join(tmpdir(), 'draft-export-'))
    try {
      for (const f of out.files) {
        mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true })
        writeFileSync(path.join(dir, f.path), f.content)
      }
      const types = path.join(ROOT, 'node_modules', '@types', 'react')
      writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            jsx: 'react-jsx',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noUncheckedIndexedAccess: true,
            verbatimModuleSyntax: true,
            types: [],
            paths: {
              react: [path.join(types, 'index.d.ts')],
              'react/jsx-runtime': [path.join(types, 'jsx-runtime.d.ts')],
            },
          },
          include: ['**/*.tsx'],
        }),
      )
      const tsc = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', dir], { encoding: 'utf8' })
      expect(tsc.stdout + tsc.stderr).toBe('')
      expect(tsc.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('writes one self-contained document for the html target', () => {
    const { frame, canvas } = canvasWith(FRAME)
    const out = exportFrameCode(frame, canvas, 'html')
    expect(out.files).toHaveLength(1)
    const html = out.files[0]!.content
    expect(html).toContain('<style data-draft-theme>')
    expect(html).toContain('<script data-draft-components>')
    expect(html).toContain('<ds-card title="Net worth"')
  })
})
