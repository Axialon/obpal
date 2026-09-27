import { describe, expect, it } from 'vitest'
import { domTemplates } from '../scripts/markup-build.mjs'

describe('the sims’ DOM template build adapter', () => {
  it('adapts sinks and keeps interpolated input outside the policy', () => {
    const source = 'el.innerHTML = `<b>${name}</b>`; el.insertAdjacentHTML("beforeend", ICONS.close)'
    const result = domTemplates(source, 'sim.ts')
    expect(result).toContain('_setMarkup(el, _html`<b>${name}</b>`)')
    expect(result).toContain('_insertMarkup(el, "beforeend", ICONS.close)')
    expect(result).not.toContain('.innerHTML =')
    expect(result).not.toContain('.insertAdjacentHTML(')
  })

  it('leaves non-template strings and joins alone, preserving file comments', () => {
    const source = '/** Simulation data. */\nconst packet = bytes.join(""); const xml = "<robot></robot>"; el.innerHTML = ""'
    const result = domTemplates(source, 'sim.ts')
    expect(result).toContain('/** Simulation data. */')
    expect(result).toContain('bytes.join("")')
    expect(result).toContain('const xml = "<robot></robot>"')
    expect(result).toContain('el.replaceChildren()')
  })
})
