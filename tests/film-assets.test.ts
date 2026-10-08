import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FILM_ASSETS, FILM_BUDGET, FilmCapacity, filmAsset, filmRange, type FilmAccess } from '../worker/film-assets'
import { addressNetworks } from '../worker/address'
import { readBytes, readText } from './devtools-node.mjs'

const film = FILM_ASSETS[0]
const url = `https://example.test/campaign/films/${film.file}`
const bytes = new Uint8Array(readBytes(`public/campaign/films/${film.file}`))
const etag = `"${film.sha256}"`
// Deterministic stream mock only: native e2e separately verifies Workers' FixedLengthStream lengths/HEAD.
beforeAll(() => vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> {
  constructor(_size: number, strategy = { highWaterMark: 65536 }) {
    super(undefined, { highWaterMark: strategy.highWaterMark, size: chunk => chunk.byteLength }, { highWaterMark: 0 })
  }
}))
afterAll(() => vi.unstubAllGlobals())
const access = (capacity = new FilmCapacity()): FilmAccess => ({ capacity, limiter: { async limit() { return { success: true } } }, async key() { return 'a'.repeat(64) }, waitUntil(job) { void job.catch(() => {}) } })
const respond = (headers: Record<string, string> = {}, method = 'GET') => filmAsset(new Request(url, { method, headers }), {
  async fetch(req) {
    expect(req.url).toBe(url)
    expect(['GET', 'HEAD']).toContain(req.method)
    for (const header of ['Range', 'If-Range', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since']) expect(req.headers.has(header)).toBe(false)
    return new Response(req.method === 'HEAD' ? null : bytes, { headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=0, must-revalidate' } })
  },
}, access())

describe('campaign film transport', () => {
  it('uses exactly the six public receipts and only their worker-first paths', () => {
    const manifest = JSON.parse(readText('public/campaign/films/manifest.json')) as { films: { file: string; bytes: number; sha256: string }[] }
    expect(FILM_ASSETS).toEqual(manifest.films.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })))
    const config = readText('wrangler.jsonc')
    for (const asset of FILM_ASSETS) {
      expect(asset.bytes).toBeLessThanOrEqual(26_214_400)
      expect(config).toContain(`"/campaign/films/${asset.file}"`)
    }
    expect(config).not.toContain('"/campaign/*"')
    expect(config).not.toContain('"/campaign/films/*"')
  })

  it('does not fetch unknown paths, encoded filenames or other methods', async () => {
    const assets = { async fetch(): Promise<Response> { throw new Error('Unexpected asset fetch') } }
    for (const path of ['/campaign/films/other.mp4', '/campaign/films/%6fbpal-original-complete-web.mp4', '/', '/api/health']) expect(await filmAsset(new Request(`https://example.test${path}`), assets, access())).toBeNull()
    for (const method of ['POST', 'PUT', 'OPTIONS', 'DELETE']) expect(await filmAsset(new Request(url, { method }), assets, access())).toBeNull()
  })

  it('preserves the full bytes, security and cache headers and supplies a strong receipt validator', async () => {
    const response = (await respond())!
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('etag')).toBe(etag)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    const actual = new Uint8Array(await response.arrayBuffer())
    expect(actual.length).toBe(bytes.length)
    expect(actual.every((byte, index) => byte === bytes[index])).toBe(true)
  })

  it.each(['bytes=0-1023', 'bytes=4096-', 'bytes=-1024', `bytes=0-${film.bytes + 100}`, 'bytes=-999999999999999999999'])('returns the exact selected bytes for %s', async range => {
    const selected = filmRange(range, film.bytes)
    if (!selected || selected === 'unsatisfiable') throw new Error('Expected selected bytes')
    const response = (await respond({ Range: range }))!
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes ${selected.start}-${selected.end}/${film.bytes}`)
    const actual = new Uint8Array(await response.arrayBuffer())
    expect(actual.length).toBe(selected.end - selected.start + 1)
    expect(actual.every((byte, index) => byte === bytes[selected.start + index])).toBe(true)
  })

  it.each([`bytes=${film.bytes}-`, 'bytes=-0', 'bytes=999999999999999999999-'])('answers unsatisfiable %s with 416', async Range => {
    const response = (await respond({ Range }))!
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${film.bytes}`)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })

  it.each(['bytes=5-2', 'bytes=-', 'bytes=wat', 'items=0-1', 'bytes=0-1,4-5', 'bytes=' + '9'.repeat(1100) + '-'])('ignores malformed or unsupported %s', async Range => {
    expect(filmRange(Range, film.bytes)).toBeNull()
    const response = (await respond({ Range }))!
    expect(response.status).toBe(200)
    expect(response.headers.has('content-range')).toBe(false)
    await response.body?.cancel()
  })

  it('honours only the exact strong If-Range validator; weak, date and different validators select full 200', async () => {
    for (const validator of [etag, `W/${etag}`, '"other"', 'Wed, 01 Oct 2025 00:00:00 GMT']) {
      const response = (await respond({ Range: 'bytes=0-1', 'If-Range': validator }))!
      expect(response.status).toBe(validator === etag ? 206 : 200)
      await response.body?.cancel()
    }
  })

  it('evaluates ETag preconditions before ranges, with strong If-Match and weak If-None-Match comparison', async () => {
    for (const method of ['GET', 'HEAD']) {
      for (const value of [etag, `W/${etag}`, '*', `"other", ${etag}`]) {
        const response = (await respond({ 'If-None-Match': value, Range: 'bytes=0-1' }, method))!
        expect(response.status).toBe(304)
        expect(response.body).toBeNull()
      }
      for (const value of ['"other"', `W/${etag}`]) expect((await respond({ 'If-Match': value }, method))!.status).toBe(412)
    }
    expect((await respond({ 'If-Match': '"other"', 'If-None-Match': etag }))!.status).toBe(412)
    for (const value of [etag, '*']) {
      const response = (await respond({ 'If-Match': value, Range: 'bytes=0-1' }))!
      expect(response.status).toBe(206)
      await response.body?.cancel()
    }
  })

  it('ignores HEAD ranges and unreliable date conditions; the native runtime checks HEAD suppression and length', async () => {
    const response = (await respond({ Range: 'bytes=0-1', 'If-Modified-Since': 'Wed, 01 Oct 2031 00:00:00 GMT', 'If-Unmodified-Since': 'Wed, 01 Oct 2020 00:00:00 GMT' }, 'HEAD'))!
    expect(response.status).toBe(200)
    expect(response.headers.has('content-range')).toBe(false)
    expect(response.headers.get('content-length')).toBe(String(film.bytes))
    await response.body?.cancel()
  })

  it('retains native missing-asset responses, rejects short or oversized bodies and cancels the source', async () => {
    const missing = new Response('Missing', { status: 404 })
    expect((await filmAsset(new Request(url), { async fetch() { return missing } }, access()))!.status).toBe(404)
    let cancelled = false
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(film.bytes + 1)) }, cancel() { cancelled = true } })
    for (const body of [new Uint8Array(1), oversized]) {
      const response = (await filmAsset(new Request(url), { async fetch() { return new Response(body) } }, access()))!
      expect(response.status).toBe(502)
      expect(response.headers.has('accept-ranges')).toBe(false)
    }
    expect(cancelled).toBe(true)
  })
})

describe('required film admission and bounded ownership', () => {
  it('shares the existing hashed IPv6 /64 key, and configuration requires the dedicated 60/minute binding', () => {
    const key = new Uint8Array(32).fill(7)
    expect(addressNetworks(key, '2001:db8:1:2::1').addr).toBe(addressNetworks(key, '2001:0db8:0001:0002::abcd').addr)
    expect(addressNetworks(key, '2001:db8:1:3::1').addr).not.toBe(addressNetworks(key, '2001:db8:1:2::1').addr)
    const config = readText('wrangler.jsonc')
    expect(config).toContain('"RL_FILM"')
    expect(config).toContain('"limit": 60, "period": 60')
    expect(FILM_BUDGET.operations * FILM_BUDGET.largest * 3).toBe(66_329_154)
    expect(FILM_BUDGET.operations * FILM_BUDGET.largest * 3).toBeLessThanOrEqual(FILM_BUDGET.bytes)
  })

  it('admits one shared deterministic burst of 60 across films/queries, then denies every kind without asset work', async () => {
    const owned = new FilmCapacity(), policy = access(owned)
    let calls = 0, fetches = 0
    const keys: string[] = []
    policy.limiter = { async limit({ key }) { keys.push(key); return { success: ++calls <= FILM_BUDGET.requests } } }
    const assets = { async fetch(req: Request) { fetches++; expect(req.method).toBe('HEAD'); return new Response(null) } }
    for (let i = 0; i < 60; i++) {
      const request = new Request(`https://example.test/campaign/films/${FILM_ASSETS[i % 6].file}?v=${i}`, { method: 'HEAD' })
      const response = (await filmAsset(request, assets, policy))!
      expect(response.status).toBe(200)
      await response.body?.cancel()
    }
    const deniedHeaders: Record<string, string>[] = [{}, { Range: 'bytes=bad' }, { Range: 'bytes=0-1,4-5' }, { Range: `bytes=${film.bytes}-` }, { 'If-None-Match': etag }]
    for (const headers of deniedHeaders) {
      for (const method of ['GET', 'HEAD']) {
        const response = (await filmAsset(new Request(url + '?other=1', { method, headers }), assets, policy))!
        expect(response.status).toBe(429)
        expect(response.headers.get('retry-after')).toBe('60')
        expect(response.headers.get('cache-control')).toBe('no-store')
      }
    }
    expect(new Set(keys).size).toBe(1)
    expect(fetches).toBe(60)
    expect(owned.operations).toBe(0)
    calls = 0
    expect((await filmAsset(new Request(url, { method: 'HEAD' }), assets, policy))!.status).toBe(200)
  })

  it('fails closed for missing/throwing limiter or key and recovers without expensive work', async () => {
    const owned = new FilmCapacity(), assets = { fetch: vi.fn(async () => new Response(null)) }
    const policies = [
      { ...access(owned), limiter: undefined },
      { ...access(owned), limiter: { async limit(): Promise<{ success: boolean }> { throw new Error('offline') } } },
      { ...access(owned), async key(): Promise<string> { throw new Error('key failure') } },
      { ...access(owned), async key() { return 'raw-ip-or-query' } },
    ]
    for (const policy of policies) {
      const response = (await filmAsset(new Request(url), assets, policy))!
      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('60')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(assets.fetch).not.toHaveBeenCalled()
    expect(owned.operations).toBe(0)
    const response = (await filmAsset(new Request(url, { method: 'HEAD' }), assets, access(owned)))!
    expect(response.status).toBe(200)
    await response.body?.cancel()
  })

  it('uses native HEAD without body reads for HEAD, 304, 412 and 416', async () => {
    const assets = { fetch: vi.fn(async (req: Request) => { expect(req.method).toBe('HEAD'); return new Response(null) }) }
    for (const [method, headers, status] of [
      ['HEAD', {}, 200], ['GET', { 'If-None-Match': etag }, 304], ['GET', { 'If-Match': '"other"' }, 412], ['GET', { Range: `bytes=${film.bytes}-` }, 416],
    ] as const) {
      const response = (await filmAsset(new Request(url, { method, headers }), assets, access()))!
      expect(response.status).toBe(status)
      await response.body?.cancel()
    }
    expect(assets.fetch).toHaveBeenCalledTimes(4)
  })

  it('holds two reservations while response consumers are stalled; denial fetches nothing; cancel/completion recover', async () => {
    const owned = new FilmCapacity(), policy = access(owned), jobs: Promise<void>[] = []
    policy.waitUntil = job => jobs.push(job)
    const assets = { fetch: vi.fn(async () => new Response(bytes)) }
    const a = (await filmAsset(new Request(url), assets, policy))!
    const b = (await filmAsset(new Request(url), assets, policy))!
    expect(owned.operations).toBe(2)
    expect(owned.bytes).toBe(66_329_154)
    const c = (await filmAsset(new Request(url), assets, policy))!
    expect(c.status).toBe(503)
    expect(c.headers.get('retry-after')).toBe('1')
    expect(assets.fetch).toHaveBeenCalledTimes(2)
    await a.body!.cancel(); await jobs[0]
    expect(owned.operations).toBe(1)
    expect((await b.arrayBuffer()).byteLength).toBe(film.bytes)
    await jobs[1]
    expect(owned.operations).toBe(0); expect(owned.bytes).toBe(0)
    const again = (await filmAsset(new Request(url), assets, policy))!
    await again.body!.cancel(); await jobs[2]
    expect(owned.operations).toBe(0)
  })

  it('recovers from abort while asset fetch is pending, cancelling a late response', async () => {
    const owned = new FilmCapacity(), abort = new AbortController()
    let resolve!: (response: Response) => void, cancelled = false
    const fetching = new Promise<Response>(done => { resolve = done })
    const pending = filmAsset(new Request(url, { signal: abort.signal }), { async fetch(req) { expect(req.signal.aborted).toBe(false); return fetching } }, access(owned))
    await vi.waitFor(() => expect(owned.operations).toBe(1))
    abort.abort()
    expect((await pending)!.status).toBe(502)
    expect(owned.operations).toBe(0)
    resolve(new Response(new ReadableStream({ cancel() { cancelled = true } })))
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })

  it('recovers from stalled asset reads and stalled response consumption using idle deadlines', async () => {
    vi.useFakeTimers()
    try {
      const owned = new FilmCapacity(), policy = access(owned)
      let cancelled = false
      const pending = filmAsset(new Request(url), { async fetch() { return new Response(new ReadableStream({ cancel() { cancelled = true } })) } }, policy)
      await vi.advanceTimersByTimeAsync(FILM_BUDGET.assetIdleMs + 1)
      expect((await pending)!.status).toBe(502)
      expect(cancelled).toBe(true); expect(owned.operations).toBe(0)
      let done!: Promise<void>; policy.waitUntil = job => { done = job }
      const response = (await filmAsset(new Request(url), { async fetch() { return new Response(bytes) } }, policy))!
      expect(owned.operations).toBe(1)
      await vi.advanceTimersByTimeAsync(FILM_BUDGET.responseIdleMs + 1)
      await done
      expect(owned.operations).toBe(0); expect(owned.bytes).toBe(0)
      await expect(response.arrayBuffer()).rejects.toThrow()
    } finally { vi.useRealTimers() }
  })

  it('recovers from short, oversized and erroring sources, and client abort during read', async () => {
    const owned = new FilmCapacity()
    for (const body of [new Uint8Array(1), new Uint8Array(film.bytes + 1), new ReadableStream({ start(c) { c.error(new Error('source failed')) } })]) {
      expect((await filmAsset(new Request(url), { async fetch() { return new Response(body) } }, access(owned)))!.status).toBe(502)
      expect(owned.operations).toBe(0); expect(owned.bytes).toBe(0)
    }
    const abort = new AbortController()
    let cancelled = false
    const pending = filmAsset(new Request(url, { signal: abort.signal }), { async fetch() { return new Response(new ReadableStream({ cancel() { cancelled = true } })) } }, access(owned))
    await vi.waitFor(() => expect(owned.operations).toBe(1))
    abort.abort()
    expect((await pending)!.status).toBe(502)
    expect(cancelled).toBe(true); expect(owned.operations).toBe(0)
  })
})
