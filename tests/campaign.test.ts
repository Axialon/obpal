import { describe, expect, it } from 'vitest'
import { readText } from './devtools-node.mjs'
import { INDEXABLE_PAGES } from '../scripts/lib/seo.mjs'

const pages = ['campaign/phone-control/index.html', 'campaign/phone-control/guide/index.html', 'campaign/phone-control/sample/index.html']

describe('campaign review previews', () => {
  it('all three resources are labelled drafts, non-indexable and use canonical native assets', () => {
    for (const page of pages) {
      const html = readText(page)
      expect(html).toContain('Local review preview')
      expect(html).toContain('Physical-phone proof remains unverified')
      expect(html).toContain('name="robots" content="noindex, nofollow"')
      for (const asset of ['/favicon.svg', '/src/styles/fonts.css', '/src/family/family.css', '/src/styles/site.css', '/src/pages/campaign.ts']) expect(html).toContain(asset)
      expect(html).not.toMatch(/campaign\.js|assets\/|<obpal-remote|mailto:|<form\b/)
      expect(INDEXABLE_PAGES).not.toContain(`/${page.replace('index.html', '')}`)
    }
    expect(readText('index.html')).not.toContain('/campaign/phone-control/')
  })

  it('enquiry has no native submission path and fails inertly before JavaScript mounts', () => {
    const html = readText(pages[0])
    expect(html).toMatch(/id="enquiry-preview-button" type="button" disabled/)
    expect(html).toContain('This preview stays on this page and is not sent')
    expect(html).not.toMatch(/<form\b|\baction=|<(?:input|textarea)[^>]*\bname=/)
    expect(html.match(/data-enquiry-field=/g)).toHaveLength(6)
    const script = readText('src/pages/campaign.ts')
    expect(script).toContain('output.textContent')
    expect(script).not.toMatch(/innerHTML|fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|clipboard|mailto:|\.submit\(/)
  })

  it('the sample names the ownership node and preserves source and physical-trial limits', () => {
    const html = readText(pages[2])
    expect(html).toContain("holder('cube')")
    expect(html).not.toContain('holder()')
    for (const hook of ['setScene({ nodes, held })', 'frame(now, who).pad1', 'obpal-button', 'obpal-join', 'obpal-leave']) expect(html).toContain(hook)
    expect(html).toContain('Source review does not prove')
    expect(html).toContain('not offer promises')
  })
})
