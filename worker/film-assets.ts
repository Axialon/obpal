/** Only the six reviewed campaign exports. Tests bind these receipts to the public manifest. */
export const FILM_ASSETS = [
  { file: 'obpal-original-complete-web.mp4', bytes: 11054859, sha256: 'faa68dd55a5f7f296bbc155dc50d1545b0e456defcd2a1ef95f56e5b8f6dab02' },
  { file: 'obpal-one-thumb-eight-arms.mp4', bytes: 4752295, sha256: '37061a184884e7b499ab406dbe4d948bf0a523940a7b341ffae70e3f43710968' },
  { file: 'obpal-make-a-mark.mp4', bytes: 7430801, sha256: '60f319085a8df8c30a881f88016572332455010ebd15cf8930fbce8202deabe3' },
  { file: 'obpal-take-the-ring.mp4', bytes: 4180284, sha256: '694b00025c504856a41f6ccc70f7f23c1b64470c0a7b5a083b7bfe0dfe6f7cf2' },
  { file: 'obpal-screen-to-track.mp4', bytes: 6028451, sha256: '91cd3d09be4e5e8040015dfef1088c5bc6e8cc648cf6f791bab20d60dd44bd4a' },
  { file: 'obpal-body-sets-the-rhythm.mp4', bytes: 4664497, sha256: 'dfd7bb6a461e8dd39bc2432e6f1cd05314a5e090662c2bbf639d29e15a43c9a6' },
] as const

import type { RateLimit } from './limits'

// The unit-test config also imports this module with DOM types. The pinned Workers runtime supplies this API.
declare const FixedLengthStream: new (length: number, strategy?: { highWaterMark: number }) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }

export const FILM_BUDGET = { requests: 60, period: 60, operations: 2, bytes: 64 * 1024 * 1024, largest: 11_054_859, chunk: 64 * 1024, assetIdleMs: 15_000, responseIdleMs: 60_000 } as const
const MAX_BYTES = 26_214_400

/** Only counters are shared by an isolate, never a request, stream, buffer, queue or media cache. */
export class FilmCapacity {
  operations = 0
  bytes = 0
  acquire(size: number): (() => void) | null {
    const reservation = size * 3
    if (size > FILM_BUDGET.largest || size > MAX_BYTES || this.operations >= FILM_BUDGET.operations || this.bytes + reservation > FILM_BUDGET.bytes) return null
    this.operations++
    this.bytes += reservation
    let released = false
    return () => { if (!released) { released = true; this.operations--; this.bytes -= reservation } }
  }
}
const capacity = new FilmCapacity()
export interface FilmAccess {
  limiter?: RateLimit
  key(): Promise<string>
  waitUntil(job: Promise<void>): void
  capacity?: FilmCapacity
}
const unavailable = (status = 503, retry = 1) => new Response('Films temporarily busy; please retry.', { status, headers: { 'Retry-After': String(retry), 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } })

/** Abort waits too: an unresponsive binding or source cannot occupy capacity indefinitely. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Film operation stopped')) }
    if (signal.aborted) { void promise.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
type ByteRange = { start: number; end: number } | 'unsatisfiable' | null

/** Ignore unsupported, malformed and multipart ranges; RFC 9110 permits a full 200 response. */
export function filmRange(value: string | null, bytes: number): ByteRange {
  if (!value || value.length > 1024) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return null
  const size = BigInt(bytes)
  if (!match[1]) {
    const suffix = BigInt(match[2])
    return suffix === 0n ? 'unsatisfiable' : { start: Number(suffix >= size ? 0n : size - suffix), end: bytes - 1 }
  }
  const start = BigInt(match[1])
  const end = match[2] ? BigInt(match[2]) : size - 1n
  if (match[2] && end < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start: Number(start), end: Number(end >= size ? size - 1n : end) }
}

/** Consume only a trusted, size-bounded asset; never retain a global media buffer or fetch another origin. */
async function readFilm(response: Response, size: number, signal: AbortSignal, touch: () => void): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body || size > MAX_BYTES) throw new Error('Invalid film size')
  const reader = response.body.getReader()
  const bytes = new Uint8Array(size)
  let offset = 0
  try {
    for (;;) {
      touch()
      const { value, done } = await abortable(reader.read(), signal)
      if (done) break
      if (offset + value.byteLength > size) throw new Error('Film exceeds receipt')
      bytes.set(value, offset)
      offset += value.byteLength
    }
    if (offset !== size) throw new Error('Film differs from receipt')
    return bytes
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Asset serving currently ignores ranges. This bounded adapter supplies exact single ranges for these films. */
export async function filmAsset(req: Request, assets: { fetch(req: Request): Promise<Response> }, access: FilmAccess): Promise<Response | null> {
  const path = new URL(req.url).pathname
  const film = FILM_ASSETS.find(f => path === `/campaign/films/${f.file}`)
  if (!film || !['GET', 'HEAD'].includes(req.method)) return null
  const stop = new AbortController()
  const abort = () => stop.abort()
  req.signal.addEventListener('abort', abort, { once: true })
  if (req.signal.aborted) abort()
  let timer: ReturnType<typeof setTimeout>
  const touch = (ms = FILM_BUDGET.assetIdleMs as number) => { clearTimeout(timer); timer = setTimeout(abort, ms) }
  let release: (() => void) | null = null
  const finish = () => { clearTimeout(timer); req.signal.removeEventListener('abort', abort); release?.(); release = null }
  touch()
  try {
    // Fail closed separately from the intentionally optional room/ICE allow(). No address or key is logged.
    if (!access.limiter) { finish(); return unavailable(503, 60) }
    const key = await abortable(access.key(), stop.signal)
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid film admission key')
    const admitted = await abortable(access.limiter.limit({ key }), stop.signal)
    if (admitted.success !== true) { finish(); return unavailable(429, 60) }
    release = (access.capacity ?? capacity).acquire(film.bytes)
    if (!release) { finish(); return unavailable() }
  } catch { finish(); return unavailable(503, 60) }
  try {
  const requestHeaders = new Headers(req.headers)
  for (const name of ['Range', 'If-Range', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since']) requestHeaders.delete(name)
  const etag = `"${film.sha256}"`
  const matches = (value: string, weak: boolean) => value.trim() === '*' || value.split(',').some(tag => (weak ? tag.trim().replace(/^W\//, '') : tag.trim()) === etag)
  const ifMatch = req.headers.get('If-Match')
  const ifNone = req.headers.get('If-None-Match')
  const ifRange = req.headers.get('If-Range')
  const range = req.method === 'GET' && (!ifRange || ifRange === etag) ? filmRange(req.headers.get('Range'), film.bytes) : null
  const status = ifMatch && !matches(ifMatch, false) ? 412 : ifNone && matches(ifNone, true) ? 304 : range === 'unsatisfiable' ? 416 : range ? 206 : 200
  const cheap = req.method === 'HEAD' || [304, 412, 416].includes(status)
  // HEAD gets native security/cache headers without fetching the complete body. Empty conditions do the same.
  touch()
  const fetching = assets.fetch(new Request(req.url, { method: cheap ? 'HEAD' : 'GET', headers: requestHeaders, signal: stop.signal }))
  void fetching.then(source => { if (stop.signal.aborted) void source.body?.cancel().catch(() => {}) }, () => {})
  const source = await abortable(fetching, stop.signal)
  if (source.status !== 200) { void source.body?.cancel().catch(() => {}); finish(); return new Response(null, { status: source.status, headers: source.headers }) }
  const headers = new Headers(source.headers)
  headers.set('Content-Type', 'video/mp4')
  headers.set('ETag', etag)
  headers.set('Accept-Ranges', 'bytes')
  headers.delete('Content-Range')
  headers.delete('Content-Encoding')
  headers.delete('Last-Modified')
  headers.delete('Content-Length')
  // There is no reliable modification date. Ignore date conditions; If-Range dates request the full film.
  if (status === 416) {
    headers.set('Content-Range', `bytes */${film.bytes}`)
  }
  if (cheap) {
    void source.body?.cancel().catch(() => {})
    if (req.method === 'HEAD' && status === 200) headers.set('Content-Length', String(film.bytes))
    finish()
    // HEAD has no producer or film buffer. Native proof checks that HTTP retains its representation length.
    return new Response(null, { status, headers })
  }
  let data: Uint8Array<ArrayBuffer> | null = await readFilm(source, film.bytes, stop.signal, touch)
  if (range && range !== 'unsatisfiable') {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${film.bytes}`)
    data = data.subarray(range.start, range.end + 1)
  }
  const stream = new FixedLengthStream(data.byteLength, { highWaterMark: FILM_BUDGET.chunk })
  const writer = stream.writable.getWriter()
  // Independent chunk copies never retain the full backing film after the producer finishes. Backpressure holds
  // the reservation during slow responses; at most a bounded chunk remains with HTTP after producer completion.
  const producing = (async () => {
    try {
      for (let offset = 0; data && offset < data.byteLength; offset += FILM_BUDGET.chunk) {
        touch(FILM_BUDGET.responseIdleMs)
        await abortable(writer.write(data.slice(offset, offset + FILM_BUDGET.chunk)), stop.signal)
      }
      await abortable(writer.close(), stop.signal)
    } catch (error) { void writer.abort(error).catch(() => {}) }
    finally { data = null; writer.releaseLock(); finish() }
  })()
  access.waitUntil(producing)
  return new Response(stream.readable, { status, headers })
  } catch { finish(); return unavailable(502) }
}
