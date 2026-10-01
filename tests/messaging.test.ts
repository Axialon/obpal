import { describe, expect, it } from 'vitest'
import { pageUrl, pageWords, PREVIEW_IMAGE, previewTags, SITE } from '../scripts/lib/preview.mjs'
import { readBytes, readText } from './devtools-node.mjs'

/**
 * The site's words about itself (spec/MESSAGING.md): every page's link preview says what the page says, with the one
 * preview image, and each page's description reads the same to UK and US readers.
 */

/** Every page the site builds (vite.config.ts), as its file in the build. */
const PAGES = [
  'index.html', 'p/index.html', 'view/index.html', 'sponsor/index.html', 'donate/index.html', 'link/index.html', 'link/desktop/index.html', 'link/try/index.html', 'privacy/index.html',
  'sim/index.html', 'sim/arm/index.html', 'sim/arena/index.html', 'sim/device/index.html', 'catalogue/index.html', 'embed/index.html',
  'buttons/index.html',
]

/** Words UK and US English spell differently (MESSAGING.md, voice rule 9). "Catalogue" is a name on this site. */
const VARIANT = /\b(colou?r(?:s|ed|ful)?|cent(?:re|er)(?:s|d|ed)?|gr[ae]y|favou?rites?|analogu?e|behaviou?rs?|travell?(?:ing|ed|er)|licen[cs]e|programmes?|(?:recogni|organi|customi|personali|optimi|visuali|synchroni|authori|summari)[sz](?:e|es|ed|ing|ation))\b/i

const home = pageWords(readText('index.html')).description
const tags = (page: string) => new Map(previewTags(readText(page), `/${page}`, { fallback: home }).map((t) => [t.attrs.property ?? t.attrs.name, t.attrs.content]))

describe('messaging', () => {
  it('every page previews with its own title and description, its address and the preview image', () => {
    for (const page of PAGES) {
      const html = readText(page)
      const t = tags(page)
      const title = /<title>([^<]+)<\/title>/.exec(html)?.[1]
      const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html)?.[1] ?? home
      expect(title, page).toBeTruthy()
      for (const k of ['og:title', 'twitter:title']) expect(t.get(k), `${page} ${k}`).toBe(title)
      for (const k of ['og:description', 'twitter:description']) expect(t.get(k), `${page} ${k}`).toBe(description)
      expect(t.get('og:url'), page).toBe(pageUrl(`/${page}`))
      for (const k of ['og:image', 'twitter:image']) expect(t.get(k), `${page} ${k}`).toBe(`${SITE}/og.png`)
      expect(t.get('twitter:card'), page).toBe('summary_large_image')
    }
    expect(pageUrl('/index.html')).toBe(`${SITE}/`)
    expect(pageUrl('/sim/arm/index.html')).toBe(`${SITE}/sim/arm/`)
  })

  it('the preview image is the 1200 × 630 PNG the tags say, in public/', () => {
    const png = readBytes(`public${PREVIEW_IMAGE.path}`)
    const u32 = (at: number) => ((png[at] << 24) | (png[at + 1] << 16) | (png[at + 2] << 8) | png[at + 3]) >>> 0
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
    expect([u32(16), u32(20)]).toEqual([PREVIEW_IMAGE.width, PREVIEW_IMAGE.height])
    // The build puts the tags on every page.
    expect(readText('vite.config.ts')).toMatch(/plugins: \[[^\]]*pagePreviews\(\)/)
  })

  it('every page’s description avoids the words UK and US English spell differently', () => {
    for (const page of PAGES) {
      const description = tags(page).get('og:description')
      expect(description, page).toBeTruthy()
      expect(description?.match(VARIANT)?.[0] ?? null, page).toBeNull()
    }
  })
})
