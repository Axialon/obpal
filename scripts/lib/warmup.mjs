/** Startup measurements use presented frames, without preserving or reading the drawing buffer. */
import sharp from 'sharp'
export const WARMUP_SIZES = [
  { name: 'desktop-1', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { name: 'desktop-2', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  { name: 'phone-3', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
]

export const WARMUP_SIMS = [
  ['hub', '/sim/'], ['arm', '/sim/arm/'], ['humanoid', '/sim/humanoid/'],
  ['drone', '/sim/drone/'], ['lamp', '/sim/lamp/'], ['submarine', '/sim/submarine/'],
]

/** Install before navigation. Instrumentation is confined to this browser context. */
export async function prepareWarmup(context, { images = false } = {}) {
  await context.addInitScript(({ images }) => {
    const events = [], frames = []
    const event = (kind, detail = {}) => events.push({ t: performance.now(), kind, ...detail })
    window.__warmup = { events, frames, reveal: null, error: null }
    let canvas = null, video = null, stream = null, previous = null, history = [], programs = -1, level = ''
    let draws = 0
    const sample = document.createElement('canvas')
    sample.width = 160; sample.height = 100
    const ctx = sample.getContext('2d', { willReadFrequently: true })
    const shot = document.createElement('canvas')
    shot.width = 480; shot.height = 300
    const shotCtx = shot.getContext('2d')
    const capture = (now, metadata) => {
      try {
        ctx.drawImage(video, 0, 0, 160, 100)
        const pixels = ctx.getImageData(0, 0, 160, 100).data
        const luma = new Float32Array(16000)
        let mean = 0, black = 0, area = 0
        for (let i = 0; i < luma.length; i++) {
          const p = i * 4
          const y = pixels[p] * .2126 + pixels[p + 1] * .7152 + pixels[p + 2] * .0722
          luma[i] = y; mean += y
          if (y < 4) black++
          if (previous && Math.abs(y - previous[i]) > 24) area++
        }
        mean /= luma.length
        let alternation = 0, alternation2 = 0, alternation3 = 0
        // A -> B -> A, allowing one intervening presented frame. Ignore sustained fades and ordinary motion.
        for (const lag of [2, 3]) {
          const a = history.at(-lag)
          if (!a) continue
          let back = 0
          for (let i = 0; i < luma.length; i++) {
            if (Math.abs(previous[i] - a[i]) > 24 && Math.abs(luma[i] - a[i]) < 8) back++
          }
          alternation = Math.max(alternation, back / luma.length)
          if (lag === 2) alternation2 = back / luma.length
          else alternation3 = back / luma.length
        }
        const last = frames.at(-1)
        const frame = { t: now, mediaTime: metadata.mediaTime, presented: metadata.presentedFrames,
          mean, delta: last ? mean - last.mean : 0, black: black / luma.length,
          area: area / luma.length, alternation, alternation2, alternation3, width: video.videoWidth, height: video.videoHeight }
        if (images) {
          shotCtx.drawImage(video, 0, 0, 480, 300)
          frame.image = shot.toDataURL('image/jpeg', .8)
        }
        frames.push(frame)
        history.push(luma); if (history.length > 3) history.shift()
        previous = luma
        const home = document.querySelector('.hero-stage')
        const hub = location.pathname === '/sim/'
        const loading = document.getElementById('sim-load')
        if (window.__warmup.reveal === null && mean > .5 &&
          (home ? document.documentElement.classList.contains('field3d') : hub ? canvas.closest('.dcard-stage')?.classList.contains('live') :
            !canvas.classList.contains('sim-warming') && (!loading || !loading.classList.contains('on')))) {
          window.__warmup.reveal = now; event('reveal')
        }
      } catch (e) { window.__warmup.error = e.message }
      if (!window.__warmup.stopped) video.requestVideoFrameCallback(capture)
    }
    const attach = (c) => {
      if (canvas || !c.isConnected || !c.matches('.hero-stage, #stage, .dcard-stage canvas')) return
      if (c.getBoundingClientRect().top >= innerHeight) return
      canvas = c
      stream = c.captureStream()
      video = document.createElement('video')
      video.muted = true; video.playsInline = true; video.srcObject = stream
      video.play().then(() => video.requestVideoFrameCallback(capture)).catch(e => { window.__warmup.error = e.message })
      event('stream', { id: c.id || c.className })
    }
    for (const key of ['width', 'height']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key)
      Object.defineProperty(HTMLCanvasElement.prototype, key, { ...descriptor, set(value) {
        if (this === canvas || this.matches('.hero-stage, #stage')) event('canvas-resize', { key, from: descriptor.get.call(this), to: value })
        descriptor.set.call(this, value)
        if (this === canvas) {
          const at = draws
          queueMicrotask(() => { if (draws === at) event('unpainted-resize', { key }) })
        }
      } })
    }
    const contexts = new WeakSet()
    const get = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (kind, options) {
      const result = get.call(this, kind, options)
      if (result && kind.startsWith('webgl') && !contexts.has(result)) {
        contexts.add(result)
        const info = result.getExtension('WEBGL_debug_renderer_info')
        event('webgl-context', { canvas: this.id || this.className, renderer: info ? String(result.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'masked' })
      }
      if (this.matches('.hero-stage, #stage, .dcard-stage canvas')) queueMicrotask(() => attach(this))
      return result
    }
    const gl = WebGL2RenderingContext.prototype
    const targets = new WeakMap()
    const bind = gl.bindFramebuffer
    gl.bindFramebuffer = function (target, framebuffer) {
      if (target === this.FRAMEBUFFER || target === this.DRAW_FRAMEBUFFER) targets.set(this, framebuffer)
      return bind.call(this, target, framebuffer)
    }
    const used = new WeakSet()
    const use = gl.useProgram
    gl.useProgram = function (program) {
      if (program && !used.has(program)) { used.add(program); event('first-use-program', { canvas: this.canvas.id || this.canvas.className }) }
      return use.call(this, program)
    }
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const original = gl[name]
      gl[name] = function (...args) { if (this.canvas === canvas && !targets.get(this)) draws++; return original.apply(this, args) }
    }
    for (const name of ['compileShader', 'linkProgram', 'texImage2D', 'texStorage2D', 'renderbufferStorageMultisample']) {
      const original = gl[name]
      gl[name] = function (...args) {
        event(name, { canvas: this.canvas.id || this.canvas.className })
        return original.apply(this, args)
      }
    }
    const Resize = ResizeObserver
    window.ResizeObserver = class extends Resize {
      constructor(callback) { super((entries, observer) => { event('resize-observer', { entries: entries.length }); callback(entries, observer) }) }
    }
    new PerformanceObserver(list => { for (const mark of list.getEntries()) events.push({ t: mark.startTime, kind: 'mark', name: mark.name }) }).observe({ type: 'mark', buffered: true })
    let overlayState = ''
    const inspect = () => {
      if (!canvas) {
        const c = document.querySelector('.hero-stage, #stage, .dcard-stage canvas')
        if (c) attach(c)
      }
      const gfx = window.__home?.gfx?.() ?? window.__gfx?.()
      if (gfx) {
        const next = JSON.stringify([gfx.level, gfx.pr, gfx.buffer, gfx.behind, gfx.still])
        // Still accumulation is included in frame data, not an event every frame.
        const quality = JSON.stringify([gfx.level, gfx.pr, gfx.buffer, gfx.behind])
        if (quality !== level) { event('quality', { gfx }); level = quality }
        if (frames.length) frames.at(-1).gfx = { ...gfx, state: next }
      }
      const renderer = window.__device?.stage?.renderer
      if (renderer && renderer.info.programs.length !== programs) { programs = renderer.info.programs.length; event('programs', { count: programs }) }
      const overlays = [...document.querySelectorAll('#sim-load, #hero-h, .hero-copy')].map(el => {
        const css = getComputedStyle(el)
        return { id: el.id || el.className, hidden: el.hidden, opacity: css.opacity, transition: css.transition, backdrop: css.backdropFilter }
      })
      const state = JSON.stringify(overlays)
      if (state !== overlayState) { event('overlays', { overlays }); overlayState = state }
      if (!window.__warmup.stopped) requestAnimationFrame(inspect)
    }
    requestAnimationFrame(inspect)
    window.__warmup.stop = () => { window.__warmup.stopped = true; stream?.getTracks().forEach(track => track.stop()) }
  }, { images })
}

/** Eight seconds after reveal, including the startup timeline. A timeout is a failed measurement, never a pass. */
export async function measureWarmup(page, url) {
  const cdp = await page.context().newCDPSession(page)
  const screens = []
  cdp.on('Page.screencastFrame', f => {
    screens.push({ t: f.metadata.timestamp * 1000, image: f.data })
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 })
  let result
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__warmup?.reveal !== null && performance.now() >= Math.max(8000, window.__warmup.reveal + 8000), null, { timeout: 60000 })
    result = await page.evaluate(() => {
      const w = window.__warmup; w.stop()
      return { frames: w.frames, events: w.events, reveal: w.reveal, error: w.error, timeOrigin: performance.timeOrigin, end: performance.now() }
    })
  } finally { await cdp.send('Page.stopScreencast'); await cdp.detach() }
  result.screens = await screenMetrics(screens, result.timeOrigin)
  return result
}

/** The compositor also presents buffer clears which captureStream omits because no drawing followed the resize. */
export async function screenMetrics(screens, timeOrigin) {
  const history = [], frames = []
  for (const screen of screens) {
    const pixels = await sharp(Buffer.from(screen.image, 'base64')).resize(160, 100, { fit: 'fill' }).removeAlpha().raw().toBuffer()
    const luma = new Float32Array(16000)
    let mean = 0, black = 0, area = 0, alternation = 0, alternation2 = 0, alternation3 = 0
    for (let i = 0; i < luma.length; i++) {
      const y = pixels[i * 3] * .2126 + pixels[i * 3 + 1] * .7152 + pixels[i * 3 + 2] * .0722
      luma[i] = y; mean += y
      if (y < 4) black++
      if (history.length && Math.abs(y - history.at(-1)[i]) > 24) area++
    }
    for (const lag of [2, 3]) {
      const a = history.at(-lag)
      if (!a) continue
      let back = 0
      for (let i = 0; i < luma.length; i++) if (Math.abs(history.at(-1)[i] - a[i]) > 24 && Math.abs(luma[i] - a[i]) < 8) back++
      alternation = Math.max(alternation, back / luma.length)
      if (lag === 2) alternation2 = back / luma.length
      else alternation3 = back / luma.length
    }
    mean /= luma.length
    frames.push({ ...screen, t: screen.t - timeOrigin, mean, delta: mean - (frames.at(-1)?.mean ?? mean),
      black: black / luma.length, area: area / luma.length, alternation, alternation2, alternation3 })
    history.push(luma); if (history.length > 3) history.shift()
  }
  return frames
}

/** These tolerances exclude small animated objects and single-pixel edge changes. */
export function flickerEvents(result) {
  const alternation = (frames, i) => Math.max(
    frames[i - 2]?.t >= result.reveal ? frames[i].alternation2 ?? frames[i].alternation : 0,
    frames[i - 3]?.t >= result.reveal ? frames[i].alternation3 ?? frames[i].alternation : 0,
  )
  return [...result.frames.flatMap((f, i) => {
    if (f.t < result.reveal) return []
    const kinds = []
    if (f.mean < .5 && f.black > .99) kinds.push('cleared')
    if (alternation(result.frames, i) > .15) kinds.push('alternation')
    if (result.frames[i - 1]?.t >= result.reveal && Math.abs(f.delta) > 15 && f.area > .35) kinds.push('setup-pop')
    return kinds.map(kind => ({ t: f.t, kind, source: 'canvas', index: i, mean: f.mean,
      area: kind === 'setup-pop' ? f.area : kind === 'cleared' ? f.black : alternation(result.frames, i) }))
  }), ...(result.screens ?? []).flatMap((f, i) => {
    if (f.t < result.reveal) return []
    const kinds = []
    if (f.mean < .5 && f.black > .99) kinds.push('cleared')
    if (alternation(result.screens, i) > .03) kinds.push('alternation')
    return kinds.map(kind => ({ t: f.t, kind, source: 'screen', index: i, mean: f.mean,
      area: kind === 'cleared' ? f.black : alternation(result.screens, i) }))
  })]
}

export function warmupFailure(result) {
  if (result.error) return result.error
  if (result.reveal === null) return 'scene never revealed'
  if (!Number.isFinite(result.end) || result.end - result.reveal < 8000) return 'less than eight seconds after reveal'
  const frames = result.frames.filter(f => f.t >= result.reveal)
  if (frames.length < 2) return 'fewer than two presented frames after reveal'
  if (!result.screens?.some(f => f.t >= result.reveal)) return 'no compositor frames after reveal'
  if ([...frames, ...result.screens].some(f => ![f.mean, f.delta, f.black, f.alternation].every(Number.isFinite))) return 'invalid frame measurement'
  const events = flickerEvents(result)
  const unpainted = result.events.find(e => e.kind === 'unpainted-resize' && e.t >= result.reveal)
  if (unpainted) return `drawing buffer cleared without a replacement frame at ${(unpainted.t / 1000).toFixed(3)}s`
  return events.length ? `${events.length} flicker events; ${events[0].kind} at ${(events[0].t / 1000).toFixed(3)}s` : null
}
