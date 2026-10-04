import { describe, expect, it } from 'vitest'
import { TRUST_QUIET_MS } from '../src/controller/linkbadge'
import { readText } from './devtools-node.mjs'

const source = (path: string) => readText(path)

describe('the phone controller’s chrome', () => {
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
