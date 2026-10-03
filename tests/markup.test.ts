import { describe, expect, it } from 'vitest'
import { guardMarkup, guardScriptURL, Markup } from '../src/ui/markup'
import { ICONS } from '../src/ui/icons'
import templates from 'virtual:obpal-templates'
import markSource from '../public/logo-mark.svg?raw'
import lockupSource from '../public/brand/obpal-link-lockup.svg?raw'

describe('the code-owned HTML policy', () => {
  it('accepts only the exact canonical vectors, before runtime theme decoration', () => {
    for (const source of [markSource, lockupSource]) {
      expect(guardMarkup(source)).toBe(source)
      expect(() => guardMarkup(source.replace('<svg ', '<svg onload="alert(1)" '))).toThrow()
      expect(() => guardMarkup(source.replace(/#c6ff34/i, '#e123ab'))).toThrow()
    }
  })
  it('accepts our static templates and icon vocabulary', () => {
    for (const s of templates) expect(guardMarkup(s)).toBe(s)
    for (const s of Object.values(ICONS)) expect(guardMarkup(s)).toBe(s)
  })

  it('refuses markup from a URL, storage, the network or a phone, even when it looks harmless', () => {
    for (const s of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '<b>Network name</b>', '<svg onload=alert(1)>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>']) {
      expect(() => guardMarkup(s)).toThrow('Not an ob.Pal template')
    }
  })

  it('refuses a known template with an injected attribute or a substituted value', () => {
    expect(() => guardMarkup(ICONS.phone.replace('<svg ', '<svg onload="alert(1)" '))).toThrow()
    const dynamic = templates.find((s) => s.includes('obpal-slot-0-end'))!
    expect(() => guardMarkup(dynamic.replace('obpal-slot-0-end', '<b>phone input</b>'))).toThrow()
  })

  it('allows only the controller’s code-owned service worker URL', () => {
    expect(guardScriptURL('/p/sw.js')).toBe('/p/sw.js')
    for (const url of ['https://elsewhere.test/sw.js', 'data:text/javascript,alert(1)', '/p/sw.js?url=x', '/p/../sw.js', 'javascript:alert(1)']) expect(() => guardScriptURL(url)).toThrow()
  })

  it('refuses implicit string concatenation of DOM templates', () => {
    expect(() => String(new Markup(['<b></b>'], []))).toThrow('Compose templates as DOM')
  })
})
