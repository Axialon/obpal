import { describe, expect, it } from 'vitest'
import { imageInfo, readText } from './store-node.mjs'

const luminance = (hex: string) => {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

describe('Chrome Web Store images', () => {
  it.each([
    ...[1, 2, 3, 4, 5].map(n => [`screenshot-${n}.png`, 1280, 800] as const),
    ['tile-440x280.png', 440, 280] as const, ['marquee-1400x560.png', 1400, 560] as const,
  ])('keeps %s at its full-bleed store size without alpha', async (file, width, height) => {
    const m = await imageInfo(`extension/store/${file}`)
    expect([m.width, m.height, m.channels]).toEqual([width, height, 3])
  })
  it('keeps caption and wordmark colours above 4.5:1 on Carbon', () => {
    const css = readText('extension/store/src/look.css')
    const token = (name: string) => css.match(new RegExp(`--${name}: (#[a-f0-9]{6});`, 'i'))![1]
    const background = luminance(token('page'))
    for (const name of ['ink', 'ink-2', 'lime']) expect((luminance(token(name)) + 0.05) / (background + 0.05)).toBeGreaterThanOrEqual(4.5)
  })
  it('uses the canonical logo for promo and screenshot compositions', () => {
    for (const file of ['poster.mjs', 'shot.mjs']) expect(readText(`extension/store/src/${file}`)).toContain('/public/brand/obpal-link-lockup.svg')
    expect(readText('extension/store/src/motif.mjs')).toContain('/public/logo-mark.svg')
  })
})

// Source contracts catch a redraw or a low-resolution replacement before it reaches any surface.
describe('the common vector identity', () => {
  it('outlines the existing wordmark and includes the exact canonical mark', () => {
    // Compare with normalised line endings: a Windows checkout may convert either file to CRLF.
    const source = readText('public/logo-mark.svg').replace(/\r\n/g, '\n').trim()
    const mark = source.slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'))
    const lockup = readText('public/brand/obpal-link-lockup.svg').replace(/\r\n/g, '\n')
    expect(lockup).toContain(mark)
    expect(lockup).not.toMatch(/<(?:image|text|foreignObject)\b/)
    expect(lockup).toContain('id="base-light"')
    const generator = readText('scripts/brand-icons.mjs')
    expect(generator).toContain("readFile(pub('logo-mark.svg')")
    expect(generator).not.toContain('<polygon')
    expect(generator).not.toContain("writeFile(pub('logo-mark.svg')")
  })
  it('uses that asset for site headers, phone identity and both Link surfaces', () => {
    const brand = readText('src/ui/brand.ts')
    expect(brand).toContain("public/brand/obpal-link-lockup.svg")
    expect(brand).toContain("public/logo-mark.svg")
    expect(brand).not.toMatch(/logo[^\n]*\.png/i)
    const icons = readText('src/ui/icons.ts')
    expect(icons).toContain('brandLockup')
    expect(icons).toContain('brandMark')
    expect(icons).not.toContain('<polygon')
    for (const surface of ['popup', 'options']) {
      const code = readText(`extension/src/${surface}/${surface}.ts`)
      expect(code).toContain('LINK_LOGO')
      expect(code).not.toContain('LOGO_WORD')
    }
  })
  it('keeps the light-view lettering readable with the family accent ink', () => {
    const svg = readText('public/brand/obpal-link-lockup.svg')
    const ink = svg.match(/#light:target~\.link-label path\{fill:(#[a-f0-9]{6})\}/i)![1]
    const family = readText('src/family/family.css')
    expect(family).toContain(`--bb-accent-ink: ${ink};`)
    // A light pill tinted by 12% lime on the light surface is darker than its outer background.
    const pill = '#eff6de'
    expect((luminance(pill) + 0.05) / (luminance(ink) + 0.05)).toBeGreaterThanOrEqual(4.5)
  })
  it('captures above output density and rejects enlarged capture pixels', () => {
    const render = readText('extension/store/src/render.mjs')
    expect(render).toContain('const SHOWN = 3')
    expect(render).toContain('Capture would be enlarged')
    for (const surface of ['poster.mjs', 'shot.mjs']) expect(readText(`extension/store/src/${surface}`)).not.toMatch(/logo[^\n]*\.png/i)
  })
})
