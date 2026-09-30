import { describe, expect, it } from 'vitest'
import { SIMS, DEVICE_IDS } from '../src/sim/catalogue'
import { AI_SIGNALS, catalogueMarkup, deviceMarkup, INDEXABLE_PAGES, robotsTxt, simUrl, sitemapXml, structuredData } from '../scripts/lib/seo.mjs'
import { readText } from './devtools-node.mjs'

const pages = new Set<string>([...INDEXABLE_PAGES, ...SIMS.map(simUrl).filter((p): p is string => Boolean(p))])
const noEmpty = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0 && value.every(noEmpty)
  if (value && typeof value === 'object') return Object.values(value).length > 0 && Object.values(value).every(noEmpty)
  return value !== null && value !== undefined
}

describe('search pages', () => {
  it('allows crawlers and points them at every canonical sim URL', () => {
    expect(robotsTxt()).toContain(`Content-Signal: ${AI_SIGNALS}`)
    expect(robotsTxt()).toContain('Sitemap: https://obpal.blackboxes.net/sitemap.xml')
    expect(robotsTxt()).not.toMatch(/Disallow:/)
    const xml = sitemapXml(SIMS, () => '2026-09-28')
    const found = [...xml.matchAll(/<loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/g)]
    expect(found).toHaveLength(pages.size)
    expect(found.every(([, url, date]) => pages.has(new URL(url).pathname) && date === '2026-09-28')).toBe(true)
    for (const id of DEVICE_IDS) expect(xml).toContain(`/sim/${id}/`)
    expect(xml).not.toContain('/sim/device/')
    expect(xml).toContain('https://obpal.blackboxes.net/trust/')
  })

  it('builds an indexable trust page with its own canonical address', () => {
    const html = readText('trust/index.html')
    expect(INDEXABLE_PAGES).toContain('/trust/')
    expect(readText('vite.config.ts')).toContain("trust: 'trust/index.html'")
    // The build inserts the canonical tag; duplicating it in source breaks the page's single address.
    expect(html).not.toContain('rel="canonical"')
    const graph = structuredData('/trust/', SIMS)['@graph'] as Record<string, unknown>[]
    expect(graph.some(node => JSON.stringify(node).includes('https://obpal.blackboxes.net/trust/'))).toBe(true)
    expect(html).not.toContain('noindex')
    expect(html).toContain('name="description"')
  })

  it('builds JSON-LD with schema.org types and no empty fields', () => {
    const types = new Set(['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage', 'Question', 'Answer', 'BreadcrumbList', 'ItemList', 'ListItem', 'Offer'])
    for (const path of pages) {
      const data = structuredData(path, SIMS)
      expect(data['@context']).toBe('https://schema.org')
      expect(noEmpty(data), path).toBe(true)
      const walk = (v: unknown) => {
        if (Array.isArray(v)) return v.forEach(walk)
        if (!v || typeof v !== 'object') return
        const object = v as Record<string, unknown>
        if (object['@type']) expect(types.has(String(object['@type'])), path).toBe(true)
        Object.values(object).forEach(walk)
      }
      walk(data)
    }
  })

  it('names the plain spelling and public profiles in home JSON-LD and metadata', () => {
    const graph = structuredData('/', SIMS)['@graph'] as Record<string, unknown>[]
    const store = 'https://chromewebstore.google.com/detail/obpal-link/jnnpcnoilofjaffabnhecfokjjknlemg'
    const links = ['https://github.com/Axialon/obpal', 'https://github.com/Axialon/obpal-link', store, 'https://www.npmjs.com/package/@obpal/host', 'https://www.npmjs.com/package/@obpal/core']
    for (const type of ['Organization', 'WebSite', 'SoftwareApplication']) {
      const node = graph.find(n => n['@type'] === type && (type !== 'SoftwareApplication' || n.name === 'ob.Pal'))!
      expect(node.alternateName).toEqual(['obpal', 'ob pal', 'OB Pal', 'obPal'])
      expect(node.sameAs).toEqual(links)
    }
    const link = (structuredData('/link/', SIMS)['@graph'] as Record<string, unknown>[]).find(n => n['@type'] === 'SoftwareApplication' && n.name === 'ob.Pal Link')!
    expect(link.installUrl).toBe(store)
    const home = readText('index.html')
    expect(home).toMatch(/<title>ob\.Pal[^<]*obpal/i)
    expect(home).toMatch(/<meta name="description" content="[^"]*obpal/)
  })

  it('uses catalogue text for the static list and each device page', () => {
    const rover = SIMS.find(c => c.id === 'rover')!
    expect(catalogueMarkup(SIMS, id => id)).toContain('href="/sim/rover/"')
    const html = deviceMarkup('<head><title>Device</title><meta name="description" content="Generic" /><link rel="canonical" href="https://obpal.blackboxes.net/sim/device/" /><meta name="robots" content="noindex, follow" /></head><h1 id="dev-name">Device</h1><p class="eyebrow" id="dev-kind">Device</p><p class="sim-lede" id="dev-blurb"></p><div class="dev-faces" id="dev-faces" role="group" aria-label="Controllers that suit it"></div>', rover, id => id)
    expect(html).toContain('href="https://obpal.blackboxes.net/sim/rover/"')
    expect(html).toContain(rover.blurb)
    expect(html).toContain('application/ld+json')
    expect(html).not.toContain('noindex')
    expect(html).not.toContain('rel="preload"')
  })
  it('names a device\'s meshes in preloads, fetched as its own request will', () => {
    const rover = SIMS.find(c => c.id === 'rover')!
    const html = deviceMarkup('<head><title>Device</title><link rel="modulepreload" href="/assets/a.js"><script type="module" src="/assets/b.js"></script></head><h1 id="dev-name">Device</h1>', rover, id => id, ['/models/rover.glb'])
    expect(html).toContain('<link rel="preload" href="/models/rover.glb" as="fetch" crossorigin fetchpriority="low" />')
    // Ahead of the page's own scripts.
    expect(html.indexOf('rel="preload"')).toBeLessThan(html.indexOf('rel="modulepreload"'))
  })
})
