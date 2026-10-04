import { describe, expect, it } from 'vitest'
import { CLIP_SECONDS, clipRow, clock, inRange, parseArgs, SEGMENTS, verdict, webmDuration } from '../scripts/lib/clips.mjs'
import { readText } from './devtools-node.mjs'

/** A WebM as Playwright's recorder (ffmpeg) writes one, in the few elements the length is read from. */
const el = (id: number[], payload: number[], size = payload.length): number[] => [...id, 0x10 | (size >> 24), (size >> 16) & 255, (size >> 8) & 255, size & 255, ...payload]
const uint = (n: number) => (n > 255 ? [n >> 8, n & 255] : [n])
const f64 = (n: number) => [...new Uint8Array(new Float64Array([n]).buffer)].reverse()
const header = el([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])
const info = (ms?: number) => el([0x15, 0x49, 0xa9, 0x66], [...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...(ms === undefined ? [] : el([0x44, 0x89], f64(ms)))])
const block = (rel: number) => el([0xa3], [0x81, rel >> 8, rel & 255, 0x80, 1, 2, 3])
const cluster = (time: number, ...rels: number[]) => el([0x1f, 0x43, 0xb6, 0x75], [...el([0xe7], uint(time)), ...rels.flatMap(block)])
const webm = (...children: number[][]) => new Uint8Array([...header, ...el([0x18, 0x53, 0x80, 0x67], children.flat())])

describe('demo clips', () => {
  it('reads a clip’s length from its Duration', () => {
    expect(webmDuration(webm(info(41_300), cluster(0, 0, 40, 80)))).toBe(41_300)
    expect(webmDuration(webm(info(60_000.4)))).toBe(60_000)
  })

  it('falls back to the newest block when the header holds no Duration', () => {
    expect(webmDuration(webm(info(), cluster(0, 0, 400), cluster(20_000, 0, 1500), cluster(40_000, 120, 280)))).toBe(40_280)
    // A block's time is signed: one just before its cluster's start does not push the length back.
    expect(webmDuration(webm(info(), cluster(5000, 0x10000 - 20)))).toBe(5000)
  })

  it('reads a segment of unknown size, as a live writer leaves it', () => {
    const open = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...info(33_000)]
    expect(webmDuration(new Uint8Array([...header, ...open]))).toBe(33_000)
  })

  it('says nothing for bytes that are no WebM', () => {
    expect(webmDuration(new Uint8Array())).toBeNull()
    expect(webmDuration(new TextEncoder().encode('GIF89a not a video'))).toBeNull()
    expect(webmDuration(webm(info()))).toBeNull()
  })

  it('records the segments of the show, in its order, each to a file of its own', () => {
    expect(SEGMENTS.map((s) => s.key)).toEqual(['home', 'viewer', 'humanoid', 'octopus', 'link', 'watch'])
    expect(new Set(SEGMENTS.map((s) => s.file)).size).toBe(SEGMENTS.length)
    expect(SEGMENTS.every((s, i) => s.file.startsWith(`0${i + 1}-`))).toBe(true)
    // The home page is shown at the quality the runbook names; the others are routed pages or sims.
    expect(SEGMENTS[0].path).toBe('/?quality=native')
    const presentation = readText('docs/PRESENTATION.md')
    for (const s of SEGMENTS) expect(presentation, s.file).toContain(s.file)
  })

  it('reads its command line', () => {
    const d = parseArgs([])
    expect(d).toMatchObject({ out: '', only: SEGMENTS.map((s) => s.key), seconds: CLIP_SECONDS.default, software: false, noLease: false, help: false })
    expect(parseArgs(['--', 'D:/clips', '--only', 'home,octopus', '--seconds=55'])).toMatchObject({ out: 'D:/clips', only: ['home', 'octopus'], seconds: 55 })
    expect(parseArgs(['--software', '--no-lease', '--wait-min', '5', '--origin', 'http://localhost:5176/'])).toMatchObject({ software: true, noLease: true, waitMin: 5, origin: 'http://localhost:5176' })
    expect(parseArgs([], { OBPAL_E2E_GPU: 'swiftshader' }).software).toBe(true)
    expect(() => parseArgs(['--only', 'drone'])).toThrow(/unknown segment drone/)
    expect(() => parseArgs(['--seconds', '20'])).toThrow(/30 to 60/)
    expect(() => parseArgs(['--seconds', '90'])).toThrow(/30 to 60/)
    expect(() => parseArgs(['a', 'b'])).toThrow(/one folder/)
    expect(() => parseArgs(['--loud'])).toThrow(/unknown option --loud/)
    expect(() => parseArgs(['--origin', 'obpal'])).toThrow(/not an origin/)
  })

  it('sums a run up: a missing clip fails, one out of range warns', () => {
    expect(clock(41_300)).toBe('41.3 s')
    expect(clock(62_000)).toBe('1:02')
    expect(clock(null)).toBe('unknown')
    expect(inRange(29_500)).toBe(true)
    expect(inRange(25_000)).toBe(false)
    expect(inRange(64_000)).toBe(false)
    const row = (ms: number | null, bytes = 1e6) => clipRow({ segment: 'home', file: '01-home-marbles.webm', ms, bytes })
    expect(row(41_300).status).toBe('pass')
    expect(row(12_000)).toMatchObject({ status: 'WARN', detail: 'outside 30 to 60 s' })
    expect(row(null).status).toBe('FAIL')
    expect(row(41_300, 0).status).toBe('FAIL')
    // A phone's own screen starts when the phone joins, so its length is not held to the 30 to 60 seconds.
    expect(clipRow({ segment: 'home', file: '01-home-marbles-phone.webm', ms: 12_000, bytes: 1e6, companion: true }).status).toBe('pass')
    expect(clipRow({ segment: 'home', file: '01-home-marbles-phone.webm', ms: null, bytes: 1e6, companion: true }).status).toBe('FAIL')
    expect(verdict([row(41_300), row(45_000)])).toMatchObject({ ok: true, line: '2 clips written' })
    expect(verdict([row(41_300), row(12_000)])).toMatchObject({ ok: true, warned: 1, line: '2 clips written, 1 to look at' })
    expect(verdict([row(41_300), row(null)])).toMatchObject({ ok: false, failed: 1 })
    expect(verdict([]).ok).toBe(false)
  })

  it('is a script of the package, kept out of the repository', () => {
    const scripts = JSON.parse(readText('package.json')).scripts
    expect(scripts['demo:clips']).toBe('node scripts/demo-clips.mjs')
    expect(readText('.gitignore')).toMatch(/^\/?artifacts\/?$/m)
  })
})
