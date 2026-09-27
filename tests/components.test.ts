import { describe, expect, it } from 'vitest'
import {
  componentScript,
  componentsStamp,
  componentUsages,
  normalizeComponent,
  normalizeComponentName,
  prepareFrameHtml,
  templateSlots,
  type ComponentDef,
} from '../shared/components.ts'

const def = (over: Partial<ComponentDef> = {}): ComponentDef => ({
  name: 'ds-stat',
  html: '<b>{{label}}</b><slot></slot>',
  css: '',
  props: [{ name: 'label' }],
  version: 1,
  updatedAt: 10,
  updatedBy: 't',
  ...over,
})

describe('component definitions', () => {
  it('requires a hyphenated, non-reserved custom element name', () => {
    expect(normalizeComponentName(' DS-Stat ')).toBe('ds-stat')
    for (const bad of ['stat', 'ds_stat', '1-x', 'font-face', 'ds-', 'a'.repeat(47) + '-b'])
      expect(() => normalizeComponentName(bad), bad).toThrow(/invalid component name/)
  })

  it('infers props from placeholders, keeps declared defaults, and rejects scripts and @import', () => {
    const d = normalizeComponent({
      name: 'ds-btn',
      html: '<button class="btn btn--{{variant}}">{{ label }}<slot></slot></button>',
      props: [{ name: 'variant', default: 'primary', description: ' primary |  secondary ' }],
    })
    expect(d.props).toEqual([
      { name: 'variant', default: 'primary', description: 'primary | secondary' },
      { name: 'label' },
    ])
    expect(() => normalizeComponent({ name: 'ds-x', html: '<script>alert(1)</script>' })).toThrow(/<script>/)
    expect(() => normalizeComponent({ name: 'ds-x', html: '<p></p>', css: '@import url(x)' })).toThrow(/@import/)
    expect(() => normalizeComponent({ name: 'ds-x', html: '  ' })).toThrow(/empty/)
    expect(() => normalizeComponent({ name: 'ds-x', html: '<p></p>', props: [{ name: 'Bad Prop' }] })).toThrow(
      /invalid prop name/,
    )
  })

  it('lists slots, default first when unnamed', () => {
    expect(templateSlots('<slot></slot><div><slot name="title"></slot><slot name=meta></slot></div>')).toEqual([
      'default',
      'title',
      'meta',
    ])
  })

  it('counts instances per frame without matching longer tag names', () => {
    const frames = [
      { id: 'a', name: 'A', html: '<ds-stat label="x">1</ds-stat><DS-STAT>2</DS-STAT><ds-stats></ds-stats>' },
      { id: 'b', name: 'B', html: '<p>none</p>' },
    ]
    expect(componentUsages(frames, 'ds-stat')).toEqual([{ frameId: 'a', frameName: 'A', count: 2 }])
  })

  it('changes the render stamp on any write or tombstone', () => {
    const a = componentsStamp([def()])
    expect(componentsStamp([def({ updatedAt: 11 })])).not.toBe(a)
    expect(componentsStamp([def(), def({ name: 'ds-b', updatedAt: 5 })])).not.toBe(a)
    expect(componentsStamp([])).toBe('0')
  })
})

describe('server render injection', () => {
  it('escapes definitions so nothing closes the script element', () => {
    const script = componentScript([def({ html: '</script><img src=x onerror=alert(1)><!-- ' })])
    const body = script.slice('<script data-doop-components>'.length, -'</script>'.length)
    expect(body).not.toMatch(/<\/script|<!--/i)
    expect(body).not.toContain(' ')
    expect(componentScript([])).toBe('')
  })

  it('puts the theme first, then the component runtime, both in <head>', () => {
    const html = prepareFrameHtml('<!doctype html><html><head><title>t</title></head></html>', 'T', [def()])
    const head = html.slice(html.indexOf('<head>') + 6)
    expect(head.startsWith('<style data-doop-theme>T</style><script data-doop-components>')).toBe(true)
    expect(head).toContain('<title>t</title>')
  })
})
