import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIMS, PARTS, SIMS, beaconInjected, brief, desktopZipHref, drawn, frameLook, guardLine, isZip, parseArgs, seconds, simTarget, stripBeacon, verdict,
} from '../scripts/lib/preflight.mjs'
import { readText } from './devtools-node.mjs'

const rgb = (...pixels: number[][]) => Uint8Array.from(pixels.flat())

describe('demo preflight: the command line', () => {
  it('defaults to the live site, every part and the three flagship sims', () => {
    const o = parseArgs([], {})
    expect(o).toMatchObject({ origin: 'https://obpal.blackboxes.net', only: PARTS, sims: DEFAULT_SIMS, budgetS: 300, withoutBeacon: false, help: false })
    expect(DEFAULT_SIMS).toEqual(['drone', 'humanoid', 'arm'])
    expect(DEFAULT_SIMS.every((s) => s in SIMS)).toBe(true)
  })

  it('reads each option, with a value after it or after =, and ignores the -- npm leaves', () => {
    const o = parseArgs(['--', '--origin', 'https://example.org/', '--sims=dog,kart', '--only', 'web,sims', '--out', 'x', '--budget=90', '--without-beacon'], {})
    expect(o).toMatchObject({ origin: 'https://example.org', sims: ['dog', 'kart'], only: ['web', 'sims'], out: 'x', budgetS: 90, withoutBeacon: true })
    expect(parseArgs([], { OBPAL_LIVE_ORIGIN: 'http://localhost:9' }).origin).toBe('http://localhost:9')
  })

  it('refuses what it does not know, naming what it does', () => {
    expect(() => parseArgs(['--nope'], {})).toThrow('unknown option --nope')
    expect(() => parseArgs(['--only', 'web,tv'], {})).toThrow(/unknown part tv \(parts: web home viewer sims\)/)
    expect(() => parseArgs(['--sims', 'octopus'], {})).toThrow(/unknown sim octopus \(sims: humanoid .*or a path such as sim\/kart\//)
    expect(() => parseArgs(['--origin', 'https://example.org/path'], {})).toThrow('not an origin')
    expect(() => parseArgs(['--budget', '0'], {})).toThrow('--budget needs a positive number')
    expect(() => parseArgs(['--out'], {})).toThrow('--out needs a value')
    expect(() => parseArgs(['--sims', ''], {})).toThrow()
  })

  it('opens a sim from its short name or from a path with or without the leading slash', () => {
    expect(simTarget('humanoid')).toEqual({ key: 'humanoid', name: 'Humanoids', path: '/sim/humanoid/' })
    expect(simTarget('sim/kart/')).toEqual({ key: '/sim/kart/', name: 'kart', path: '/sim/kart/' })
    expect(simTarget('/sim/arm/?kind=so101').path).toBe('/sim/arm/?kind=so101')
    expect(parseArgs(['--sims', 'sim/kart/,drone'], {}).sims).toEqual(['sim/kart/', 'drone'])
    // Every short name is a sim page of the site.
    for (const s of Object.values(SIMS)) expect(s.path).toMatch(/^\/sim\/[\w/.?=-]+$/)
  })
})

describe('demo preflight: what counts as a drawn frame', () => {
  it('sees a clear colour as nothing and a picture as something', () => {
    const blank = new Uint8Array(96 * 54 * 3).fill(10)
    expect(frameLook(blank)).toEqual({ colours: 1, mean: 10, spread: 0 })
    expect(drawn(frameLook(blank))).toBe(false)
    const picture = new Uint8Array(96 * 54 * 3)
    for (let i = 0; i < picture.length; i += 3) { const n = i / 3; picture[i] = (n * 7) % 256; picture[i + 1] = (n * 13) % 256; picture[i + 2] = (n * 29) % 256 }
    expect(drawn(frameLook(picture))).toBe(true)
  })

  it('wants both enough colours and enough spread', () => {
    expect(drawn({ colours: 15, mean: 40, spread: 30 })).toBe(false)
    expect(drawn({ colours: 40, mean: 40, spread: 3.9 })).toBe(false)
    expect(drawn({ colours: 16, mean: 40, spread: 4 })).toBe(true)
    expect(frameLook(rgb([0, 0, 0], [255, 255, 255]))).toMatchObject({ colours: 2, mean: 127.5 })
    expect(frameLook(new Uint8Array())).toEqual({ colours: 0, mean: 0, spread: 0 })
  })
})

describe('demo preflight: Cloudflare\'s script, zips and links', () => {
  const tag = '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v31edd" integrity="sha512-x" data-cf-beacon=\'{"version":"2024.11.0"}\' crossorigin="anonymous"></script>'

  it('finds the injected analytics script and takes it out, and only it', () => {
    const page = `<html><body><script type="module" src="/assets/sim.js"></script><p>hi</p>${tag}</body></html>`
    expect(beaconInjected(page)).toBe(true)
    expect(stripBeacon(page)).toBe('<html><body><script type="module" src="/assets/sim.js"></script><p>hi</p></body></html>')
    expect(beaconInjected(stripBeacon(page))).toBe(false)
    expect(beaconInjected('<script type="module" src="/assets/sim.js"></script>')).toBe(false)
  })

  it('knows a zip from its first bytes', () => {
    expect(isZip(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true)
    expect(isZip(Uint8Array.from([0x3c, 0x21, 0x44, 0x4f]))).toBe(false)
    expect(isZip(new Uint8Array(2))).toBe(false)
  })

  it('finds the Windows helper\'s download on its page', () => {
    const html = '<a class="btn" href="https://github.com/Axialon/obpal-link/releases/latest/download/obpal-desktop-windows-x64.zip">Download for Windows</a>'
    expect(desktopZipHref(html)).toBe('https://github.com/Axialon/obpal-link/releases/latest/download/obpal-desktop-windows-x64.zip')
    expect(desktopZipHref('<a href="https://example.org/x.zip">x</a>')).toBeNull()
  })
})

describe('demo preflight: the table, the verdict and the guard', () => {
  const row = (check: string, status: string) => ({ part: 'p', check, status })

  it('turns an error into one line without a pairing secret', () => {
    const e = new Error('page.goto: Timeout 40000ms exceeded.\nCall log:\n  - navigating to "https://obpal.blackboxes.net/p/#c.play.room.SECRETKEY", waiting until "load"')
    expect(brief(e)).toBe('Timeout 40000ms exceeded.')
    expect(brief('could not open https://obpal.blackboxes.net/p/#s.w.room.SECRET now')).toBe('could not open https://obpal.blackboxes.net/p/ now')
    expect(brief('fetch failed ?token=abc https://example.org/a?x=1 end')).not.toContain('x=1')
    expect(brief(new Error('x'.repeat(300))).length).toBe(160)
    expect(brief(new Error(''))).toBe('failed')
  })

  it('says ready only when nothing failed and nothing was skipped', () => {
    expect(verdict([row('a', 'pass'), row('b', 'pass')])).toMatchObject({ ready: true, failed: 0, line: 'READY: 2 of 2 checks passed' })
    expect(verdict([row('a', 'pass'), row('b', 'WARN')])).toMatchObject({ ready: true, warned: 1, line: 'READY: 1 of 2 checks passed, 1 warning' })
    const bad = verdict([row('a', 'pass'), row('home', 'FAIL'), row('sims', 'FAIL'), row('watch', 'skip')])
    expect(bad).toMatchObject({ ready: false, failed: 2, skipped: 1 })
    expect(bad.line).toBe('NOT READY: 2 failed (home, sims), 1 skipped')
    expect(verdict([row('a', 'pass'), row('b', 'skip')])).toMatchObject({ ready: false, line: 'NOT READY: 1 not run' })
  })

  it('shows durations as a person reads them', () => {
    expect([seconds(33), seconds(1300), seconds(12_400), seconds(66_000)]).toEqual(['33 ms', '1.3 s', '12 s', '1.1 min'])
  })

  it('reads the helper\'s log the way the e2e runner does: only new lines naming a test browser count', () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const before = enc('start\nsession from Z:/runner/cache/ms-playwright/chromium-1237/chrome.exe\n')
    expect(guardLine(before, before).line).toBe('ob.Pal Desktop log: 1 test-browser lines before, 1 after; no new sessions')
    const after = enc(`${new TextDecoder().decode(before)}opened by Z:/runner/cache/ms-playwright/chromium-1243/chrome.exe\nunrelated\n`)
    const gained = guardLine(before, after)
    expect(gained.reached).toHaveLength(1)
    expect(gained.line).toContain('1 NEW')
    expect(guardLine(before, after, ['custom/chrome.exe']).reached).toHaveLength(1)
    expect(guardLine(null, null).line).toBe('ob.Pal Desktop guard: no new sessions (no helper log present)')
    // A log the helper started afresh is new from its first line.
    expect(guardLine(enc('x'.repeat(500)), enc('ms-playwright\n')).reached).toHaveLength(1)
  })
})

describe('demo preflight: how it is wired', () => {
  it('is a package script that reuses check:live\'s parts and keeps secrets out of what it prints', () => {
    const pkg = JSON.parse(readText('package.json')).scripts
    expect(pkg['demo:preflight']).toBe('node scripts/demo-preflight.mjs')
    const script = readText('scripts/demo-preflight.mjs')
    expect(script).toContain("from './lib/live.mjs'")
    expect(script).toContain("from './lib/live-browser.mjs'")
    expect(readText('scripts/check-live.mjs')).toContain("from './lib/live-browser.mjs'")
    // Neither link a phone is given nor one a guest opens is printed, saved or put in a table cell.
    expect(script).not.toMatch(/console\.log\([^)]*(?:pairingUrl|invite|shortShareUrl)/)
    expect(script).toContain('No pairing link or watch link is printed or kept')
  })
})
