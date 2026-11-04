import { describe, expect, it } from 'vitest'
import { TRUST_QUIET_MS } from '../src/controller/linkbadge'
import { readText } from './devtools-node.mjs'

const source = (path: string) => readText(path)

/** Read the palette's explicit lengths for a conservative geometry check, not a browser hit-test substitute. */
function paletteGeometry() {
  const css = source('src/styles/controller.css'), family = source('src/family/family.css')
  const rule = (text: string, selector: string) => {
    const start = text.indexOf(`${selector} {`)
    expect(start, selector).toBeGreaterThanOrEqual(0)
    return Object.fromEntries(text.slice(text.indexOf('{', start) + 1, text.indexOf('}', start)).split(';').filter(s => s.includes(':')).map(s => s.trim().split(/:\s*/)))
  }
  const grid = rule(css, '.accent-row'), button = rule(css, '.accent-row .bb-accent'), extension = rule(css, '.accent-row .bb-accent::after')
  return { width: parseFloat(button.width), height: parseFloat(button.height), inset: parseFloat(extension.inset), rowGap: parseFloat(grid.gap), margin: parseFloat(grid['margin-inline'] ?? '0'), columns: Number(grid['grid-template-columns'].match(/repeat\((\d+),/)?.[1]), hover: Number(rule(family, '.bb-accent:hover').transform.match(/scale\(([\d.]+)\)/)?.[1]) }
}

describe('the phone controller’s chrome', () => {
  it('lets enlarged Settings titles and subtitles grow on separate lines', () => {
    const css = source('src/styles/controller.css')
    const text = css.match(/\.set-row > span:not\(\.set-srcs\) \{([^}]+)\}/)![1]
    const small = css.match(/\.set-row small \{([^}]+)\}/)![1]
    const row = css.match(/\.set-row \{([^}]+)\}/)![1]
    const titleLine = Number(text.match(/line-height:\s*([\d.]+);/)?.[1])
    const smallLine = Number(small.match(/line-height:\s*([\d.]+);/)?.[1])
    expect(titleLine, 'unitless line height follows the doubled primary font').toBeGreaterThanOrEqual(1.2)
    expect(smallLine, 'secondary text has its own readable line height').toBeGreaterThanOrEqual(1.2)
    const gapValue = text.match(/gap:\s*([^;]+);/)![1], token = gapValue.match(/var\((--[\w-]+)\)/)?.[1]
    const gap = parseFloat(token ? css.match(new RegExp(`${token}:\\s*([\\d.]+)px`))![1] : gapValue)
    // Native enlarged rows: 35px primary Range boxes, subtitles beginning 30–31px later at the old 4px gap.
    for (const separation of [30, 31, 31, 31, 30]) expect(separation + gap - 4 - 35, 'saved fitted-line envelope has positive separation').toBeGreaterThanOrEqual(1)
    expect(row).toMatch(/height:\s*auto;/)
    expect(row).toMatch(/padding:\s*[1-9][\d.]*px/)
    expect(29 * titleLine * 2 + 12 * smallLine).toBeGreaterThan(58)
  })

  it('contains the original palette edge touches and the full pixel around a rounded click', () => {
    const geometry = paletteGeometry()
    // A real edge touch reached its swatch while the rounded click missed. Reserve its full pixel;
    // this bound deliberately makes no claim about the browser's internal targeting algorithm.
    const samples = [0, -21.75, 21.75, -15.35, 15.35]
    for (const [size, observedCenter] of [[geometry.width, 209.1875], [geometry.height, 434.796875]]) {
      for (const center of [observedCenter, ...Array.from({ length: 64 }, (_, i) => 200 + i / 64)]) {
        const low = center - size / 2 + geometry.inset, high = center + size / 2 - geometry.inset
        for (const offset of samples) {
          const touch = center + offset, click = Math.round(touch)
          expect(touch, `touch ${touch} above ${low}`).toBeGreaterThan(low)
          expect(touch, `touch ${touch} below ${high}`).toBeLessThan(high)
          expect(click - 0.5, `rounded click pixel at ${click} above ${low}`).toBeGreaterThanOrEqual(low)
          expect(click + 0.5, `rounded click pixel at ${click} below ${high}`).toBeLessThanOrEqual(high)
        }
      }
    }
  })

  it('separates palette hit areas in both axes throughout neighboring hover transitions', () => {
    const g = paletteGeometry(), hitWidth = (g.width - 2 * g.inset) * g.hover, hitHeight = (g.height - 2 * g.inset) * g.hover
    // 246px is the narrow phone's measured content width; 438px is the 480px sheet's content width.
    for (const contentWidth of [246, 438]) {
      const columnPitch = (contentWidth - 2 * g.margin) / g.columns, rowPitch = g.height + g.rowGap
      expect(columnPitch, 'both neighboring hover envelopes fit each column').toBeGreaterThan(hitWidth)
      expect(rowPitch, 'both neighboring hover envelopes fit each row').toBeGreaterThan(hitHeight)
      expect(g.margin + columnPitch / 2 - hitWidth / 2, 'outer hit area stays within the sheet padding').toBeGreaterThan(-20)
    }
  })

  it('names the trackpad’s double tap as 2× reset, not an encoding loss', () => {
    const main = source('src/controller/main.ts')
    expect(main).not.toContain('2? reset')
    expect(main.match(/2× reset/g)?.length).toBe(2)
  })

  it('quiets the first connection notice after a few seconds, keeping its words and actions', () => {
    expect(TRUST_QUIET_MS).toBeGreaterThanOrEqual(3000)
    expect(TRUST_QUIET_MS).toBeLessThanOrEqual(6000)
    const badge = source('src/controller/linkbadge.ts')
    // Quiet, not gone: the sentence (folded) and Compare seal stay in the notice (in the gate card, What this shares and the close too).
    expect(badge).toContain("'Connected to the screen showing this seal'")
    expect(badge).toMatch(/first\.dataset\.quiet = ''/)
    const css = source('src/styles/controller.css')
    expect(badge).toContain("'Compare seal'")
    expect(css).toContain('.trust-first[data-quiet] .trust-compare > .trust-short { display: inline;')
  })

  it('puts what isn’t play on the gamepad under More: the connection and its seal, and a shared scene’s drop-ins', () => {
    const pad = source('src/controller/gamepad.ts')
    expect(pad).toContain('data-act="more"')
    expect(pad).toContain('class="gp-meta-list"')
    expect(source('src/controller/linkbadge.ts')).toContain(".gp-meta-list')")
    const main = source('src/controller/main.ts')
    expect(main).toContain("surface?.querySelector('.gp-meta-list') ?? surface?.querySelector('.gp-mid')")
  })

  it('gives the hand and body cameras glyphs of their own', () => {
    const switcher = source('src/controller/switcher.ts')
    expect(switcher).toContain("ICONS['hand-cam']")
    expect(switcher).toContain('ICONS.body')
    expect(switcher).not.toMatch(/ctl-tab-ic">\$\{ICONS\.camera\}/)
  })
})
