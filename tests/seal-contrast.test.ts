import { readText } from './devtools-node.mjs'
import { afterEach, expect, it, vi } from 'vitest'
import { contrast, mix, parseColor } from '../packages/host/src/color'
import { resolveDotTokens } from '../packages/host/src/dot-tokens'
import { SEAL_STYLE } from '../packages/host/src/seal'

const css = readText('src/family/family.css').replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
  selectors: selectors.trim().split(',').map(s => s.trim()),
  tokens: Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()])),
}))
const rule = (selector: string) => {
  const match = rules.find(r => r.selectors.includes(selector))
  if (!match) throw new Error(`Missing family rule: ${selector}`)
  return match.tokens
}
const themes = ['carbon', 'navy', 'violet', 'wine', 'onyx', 'light']
const accents = ['product', 'lime', 'lavender', 'turquoise', 'candy', 'sky', 'rose', 'amber', 'mint']
afterEach(() => vi.unstubAllGlobals())

it.each(themes.flatMap(theme => accents.map(accent => [theme, accent])))('%s / %s keeps opaque seal ink above 4.5:1 on its family backing', (theme, accent) => {
  const light = theme === 'light'
  const tokens: Record<string, string> = {
    ...rule(':root'), ...rule(light ? ":where([data-bb-product='obpal'])[data-bb-theme='light']" : `[data-bb-theme='${theme}']`),
    ...rule("[data-bb-product='obpal']"), ...(accent === 'product' ? {} : rule(`[data-bb-accent='${accent}']`)),
  }
  if (light) {
    const selected = `[data-bb-${accent === 'product' ? "product='obpal']:not([data-bb-accent])" : `accent='${accent}']`}`
    Object.assign(tokens, rules.find(r => r.selectors.some(s => s.startsWith(":where([data-bb-product='obpal'])[data-bb-theme='light']") && s.endsWith(selected)))?.tokens)
  }
  tokens['--bb-accent-text'] = tokens[light ? '--bb-accent-strong' : '--bb-accent']
  tokens['--ink'] = tokens['--bb-ink']
  // Resolve the live seal's semantic role, including its fallback chain.
  const active = /--ob-dot-active:([^}]+)/.exec(SEAL_STYLE)![1]
  let resolved = active
  while (resolved.includes('var(')) resolved = resolved.replace(/var\((--[\w-]+)(?:,([^()]*))?\)/g, (_, name, fallback) => tokens[name] ?? fallback ?? '')
  tokens['--ob-dot-active'] = resolved
  vi.stubGlobal('getComputedStyle', () => ({ color: tokens['--bb-ink'], getPropertyValue: (name: string) => tokens[name] ?? '' }))
  const color = parseColor(resolveDotTokens({} as Element, 'seal').colors.active)!
  const sheet = parseColor(tokens['--bb-sheet'])!, surface = parseColor(tokens['--bb-surface-rgb'])!, page = parseColor(tokens['--bb-page'])!
  expect(SEAL_STYLE).toContain('background:var(--seal-plate,var(--bb-sheet')
  for (const background of [sheet, surface, page, mix(page, surface, 0.96)]) expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5)
  if (light) expect(color).not.toEqual(parseColor(tokens['--bb-accent']))
})
