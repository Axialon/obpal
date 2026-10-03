import { describe, expect, it } from 'vitest'

const sources = import.meta.glob<string>([
  '../src/styles/*.css', '../src/family/family.css', '../src/landing/controls.css', '../extension/src/ui/link.css',
  '../extension/src/popup/popup.css', '../extension/src/options/options.css',
  '../extension/src/popup/popup.ts', '../packages/host/src/chip.ts', '../packages/host/src/seal-surface.ts',
], { query: '?raw', import: 'default', eager: true })

describe('keyboard interaction indicators', () => {
  it('does not introduce white borders for mouse hover', () => {
    const violations: string[] = []
    for (const [file, content] of Object.entries(sources)) {
      const source = content.replace(/\/\*[\s\S]*?\*\//g, '')
      for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!rule[1].includes(':hover')) continue
        for (const declaration of rule[2].matchAll(/\bborder(?:-(?:top|right|bottom|left))?(?:-color)?\s*:\s*([^;]+)/g)) {
          if (/(?:#fff(?:fff)?\b|\bwhite\b|rgba?\(\s*255[\s,]+255[\s,]+255|var\(--hl-rgb\))/.test(declaration[1])) violations.push(`${file}: ${rule[1].trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('never removes an indicator in a focus-visible rule', () => {
    const violations: string[] = []
    for (const [file, content] of Object.entries(sources)) {
      const source = content.replace(/\/\*[\s\S]*?\*\//g, '')
      for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!rule[1].replace(/:not\(\s*:focus-visible\s*\)/g, '').includes(':focus-visible')) continue
        if (/outline(?:-style|-width)?\s*:\s*(?:none|hidden|0(?:px|em|rem)?)(?:\s|;|$)|outline(?:-color)?\s*:[^;]*\btransparent\b/.test(rule[2])) violations.push(`${file}: ${rule[1].trim()}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('does not use an external outline as the persistent selected state', () => {
    const violations: string[] = []
    for (const [file, content] of Object.entries(sources)) {
      for (const rule of content.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/aria-(?:pressed|checked|selected)|:checked|\.is-active/.test(rule[1]) && !rule[1].includes(':focus') && /outline\s*:/.test(rule[2])) violations.push(file)
      }
    }
    expect(violations).toEqual([])
  })
})
