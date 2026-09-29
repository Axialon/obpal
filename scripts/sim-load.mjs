/**
 * Films how a sim loads, on a cold cache and a throttled mid-phone connection, for the before-and-after of the first
 * paint of a device: its video, and a strip of frames every 50 ms of the first second and of the moment the mesh
 * arrives.
 *
 *   OBPAL_E2E_WORKER_PORT=<port> node scripts/sim-load.mjs --label after
 *   Options: --label <name> (the folder under --out), --out <dir> (default artifacts/sim-load), --sims
 *   so101,drone,rover,kart (see SIMS), --views desktop,phone, --seconds <n> (how long each load is filmed; 14),
 *   --no-throttle, --no-repeat (skip the second visit with a warm cache).
 *
 * The site is this checkout's last build (dist/client, from `vite build`) served by its own local worker
 * (`wrangler dev`, scripts/local-worker.mjs), which answers as production does: brotli, an ETag, and Cache-Control
 * max-age=0 with must-revalidate. Each sim opens in a fresh browser context (no cache), with the network held to
 * 1.6 Mbit/s down and 150 ms of latency and the CPU to a quarter of its speed (the profile Lighthouse calls a mid
 * phone). Writes, per sim and view:
 *   <sim>-<view>.webm            the whole load
 *   <sim>-<view>-timeline.png    the whole film, a frame every half second
 *   <sim>-<view>-first.png       50 ms frames for the first second of the device area: from just before its rig
 *                                (the procedural stand-in, or since the change the loading state) is put in the scene
 *   <sim>-<view>-arrival.png     50 ms frames around the moment the Blender mesh is installed
 *   <sim>-<view>.json            what the page reported: timings, the mesh request, its cost when the page is opened again with
 *                                the cache warm, and (the build with ?test=load) a
 *                                record of every drawn frame and whether a procedural stand-in was in it
 * and summary.json for the run. Needs sharp and Playwright's own ffmpeg (npx playwright install ffmpeg). Evidence only:
 * artifacts/ is ignored by git.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { resolveChromium } from './lib/browser.mjs'
import { startWorker } from './local-worker.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const label = option('label', 'run')
const out = join(resolve(root, option('out', 'artifacts/sim-load')), label)
const seconds = Number(option('seconds', 14))
const throttled = !args.includes('--no-throttle')
const again = !args.includes('--no-repeat')

/** The sims filmed: an arm, a drone, a rover and skinned devices, by the page a visitor opens. */
const SIMS = {
  so101: { path: '/sim/arm/?kind=so101', model: 'so101' },
  arm5: { path: '/sim/arm/?kind=arm5', model: 'arm5' },
  drone: { path: '/sim/drone/', model: 'drone' },
  rover: { path: '/sim/rover/', model: 'rover' },
  kart: { path: '/sim/kart/', model: 'kart' },
  helicopter: { path: '/sim/helicopter/', model: 'helicopter' },
  gimbal: { path: '/sim/gimbal/', model: 'gimbal' },
  studio: { path: '/sim/studio/', model: 'studio' },
}
const VIEWS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
}
/** A mid phone: Lighthouse's simulated mobile network and a 4x CPU slowdown. */
const PROFILE = { latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8, cpu: 4 }

const sims = option('sims', 'so101,drone,rover,kart').split(',').map(s => s.trim()).filter(Boolean)
const views = option('views', 'desktop,phone').split(',').map(s => s.trim()).filter(Boolean)
for (const s of sims) if (!SIMS[s]) throw new Error(`unknown sim ${s} (known: ${Object.keys(SIMS).join(' ')})`)
for (const v of views) if (!VIEWS[v]) throw new Error(`unknown view ${v} (known: ${Object.keys(VIEWS).join(' ')})`)

/** Playwright's own ffmpeg, which it records video with. */
function ffmpeg() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ms-playwright')
  const folders = existsSync(cache) ? readdirSync(cache).filter(n => /^ffmpeg-\d+$/.test(n)).sort().reverse() : []
  for (const f of folders) for (const exe of ['ffmpeg-win64.exe', 'ffmpeg-linux', 'ffmpeg-mac']) if (existsSync(join(cache, f, exe))) return join(cache, f, exe)
  throw new Error('Playwright\'s ffmpeg is not installed (npx playwright install ffmpeg)')
}

/** Frames of `video` from `start` for `length` seconds, every `step` seconds, as PNG files in `dir` (`width` px wide, if given). */
function frames(video, dir, start, length, step, width) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const run = spawnSync(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, start)), '-i', video, '-t', String(length), '-r', String(1 / step), ...(width ? ['-vf', `scale=${width}:-1`] : []), '-f', 'image2', join(dir, '%03d.png')], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`ffmpeg: ${run.stderr}`)
  return readdirSync(dir).filter(n => n.endsWith('.png')).sort().map(n => join(dir, n))
}

/** A grid of frames, left to right and top to bottom, each with its time. */
async function strip(files, file, from, step, columns, width) {
  const first = await sharp(files[0]).metadata()
  const height = Math.round(width * first.height / first.width)
  const rows = Math.ceil(files.length / columns), gap = 6
  const tiles = await Promise.all(files.map(async (f, i) => {
    const time = `${(from + i * step) >= 0 ? '+' : ''}${(from + i * step).toFixed(2)}s`
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22"><rect width="100%" height="100%" fill="#000" fill-opacity=".62"/><text x="6" y="16" font-family="Arial, sans-serif" font-size="14" fill="#fff">${time}</text></svg>`)
    const base = await sharp(f).resize(width, height).png().toBuffer()
    return { input: await sharp(base).composite([{ input: label, top: 0, left: 0 }]).png().toBuffer(), left: (i % columns) * (width + gap), top: Math.floor(i / columns) * (height + gap) }
  }))
  await sharp({ create: { width: columns * (width + gap) - gap, height: rows * (height + gap) - gap, channels: 3, background: '#20242c' } }).composite(tiles).png().toFile(file)
}

mkdirSync(out, { recursive: true })
const chrome = await resolveChromium()
const local = await startWorker({ port: Number(process.env.OBPAL_E2E_WORKER_PORT) })
const summary = []
let browser
try {
  browser = await chromium.launch({ executablePath: chrome.path || undefined, headless: true, })
  for (const id of sims) for (const view of views) {
    const name = `${id}-${view}`, sim = SIMS[id]
    const dir = join(out, name)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const context = await browser.newContext({ ...VIEWS[view], recordVideo: { dir, size: VIEWS[view].viewport } })
    const page = await context.newPage()
    const opened = Date.now()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    // The moment the sim's stage first asks for a graphics context: the point its first frame follows.
    await page.addInitScript(() => {
      const get = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (...a) { if (!window.__stage0 && this.id === 'stage') window.__stage0 = performance.now(); return get.apply(this, a) }
    })
    const cdp = await context.newCDPSession(page)
    if (throttled) {
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: PROFILE.latency, downloadThroughput: PROFILE.downloadThroughput, uploadThroughput: PROFILE.uploadThroughput })
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpu })
    }
    // A solid page first, so the film has a first change of picture to line the page's clock up with.
    await page.setContent('<!doctype html><body style="margin:0;background:#f0f">')
    await page.waitForTimeout(500)
    const began = Date.now()
    await page.goto(`${local.origin}${sim.path}${sim.path.includes('?') ? '&' : '?'}test=load&quality=native`, { waitUntil: 'commit' })
    await page.waitForTimeout(seconds * 1000)
    const report = await page.evaluate(model => {
      const glb = performance.getEntriesByType('resource').filter(r => /\/models\/[^/]+\.glb/.test(r.name)).map(r => ({ url: new URL(r.name).pathname, start: r.startTime, end: r.responseEnd, transfer: r.transferSize, decoded: r.decodedBodySize, initiator: r.initiatorType }))
      const mark = n => performance.getEntriesByName(`obpal:${model}:${n}`)[0]?.startTime ?? null
      return {
        origin: performance.timeOrigin, stage: window.__stage0 ?? null, paint: performance.getEntriesByName('first-paint')[0]?.startTime ?? null,
        marks: { held: mark('held'), load: mark('load'), decoded: mark('decoded'), visible: mark('visible') },
        glb, frames: window.__loadFrames ?? null, loader: !!document.getElementById('sim-load') && !document.getElementById('sim-load').hidden,
        rigs: window.__rigs ? window.__rigs() : null,
      }
    }, sim.model)
    // Back to the same page with the cache warm: the mesh should cost a revalidation (a 304), not a download.
    if (again) { await page.goto(`${local.origin}${sim.path}`, { waitUntil: 'load' }); await page.waitForTimeout(6000) }
    const repeat = !again ? null : await page.evaluate(() => performance.getEntriesByType('resource').filter(r => /\/models\/[^/]+\.glb/.test(r.name)).map(r => ({ url: new URL(r.name).pathname, transfer: r.transferSize, body: r.encodedBodySize, duration: Math.round(r.duration), initiator: r.initiatorType })))
    const recording = page.video()
    await context.close()
    const video = await recording.path()
    const webm = join(out, `${name}.webm`)
    rmSync(webm, { force: true })
    renameSync(video, webm)
    // The film's clock starts when the page opened; the page's, at navigation. They meet where the solid page first changes: the page's first paint.
    let offset = (began - opened) / 1000 + (report.origin - began) / 1000
    if (report.paint !== null) {
      const first = frames(webm, join(dir, 'sync'), 0, 8, 0.05, 32)
      for (const [i, f] of first.entries()) {
        const { data } = await sharp(f).extract({ left: 4, top: 4, width: 8, height: 8 }).raw().toBuffer({ resolveWithObject: true })
        if (Math.abs(data[0] - 255) > 24 || Math.abs(data[1]) > 24 || Math.abs(data[2] - 255) > 24) { offset = i * 0.05 - report.paint / 1000; break }
      }
    }
    const at = ms => ms === null ? null : ms / 1000 + offset
    const stage = at(report.marks.held ?? report.marks.load), arrival = at(report.marks.visible)
    const shots = {}
    // The whole film at a coarse step, on the video's own clock, to see where everything falls.
    {
      const files = frames(webm, join(dir, 'timeline'), 0, seconds, 0.5)
      await strip(files, join(out, `${name}-timeline.png`), 0, 0.5, 7, view === 'phone' ? 100 : 220)
      shots.timeline = `${name}-timeline.png`
    }
    if (stage !== null) {
      const from = -0.1
      const files = frames(webm, join(dir, 'first'), stage + from, 1, 0.05)
      await strip(files, join(out, `${name}-first.png`), from, 0.05, 5, view === 'phone' ? 150 : 300)
      shots.first = `${name}-first.png`
    }
    if (arrival !== null) {
      const from = -0.4
      const files = frames(webm, join(dir, 'arrival'), arrival + from, 1, 0.05)
      await strip(files, join(out, `${name}-arrival.png`), from, 0.05, 5, view === 'phone' ? 150 : 300)
      shots.arrival = `${name}-arrival.png`
    }
    rmSync(dir, { recursive: true, force: true })
    const standIn = report.frames ? report.frames.filter(f => f.standIn).length : null
    const row = { sim: id, view, stage: report.stage, marks: report.marks, mesh: report.glb.find(g => g.url.endsWith(`/${sim.model}.glb`)) ?? null, drawn: report.frames?.length ?? null, framesWithStandIn: standIn, firstStandIn: report.frames?.find(f => f.standIn)?.t ?? null, loaderStillShown: report.loader, repeat, errors, ...shots }
    writeFileSync(join(out, `${name}.json`), JSON.stringify({ ...row, frames: report.frames, glb: report.glb, rigs: report.rigs }, null, 1))
    summary.push(row)
    console.log(`${name}: stage ${row.stage?.toFixed(0)} ms, mesh visible ${row.marks.visible?.toFixed(0) ?? 'never'} ms${standIn === null ? '' : `, ${standIn}/${row.drawn} drawn frames with the stand-in`}${errors.length ? `, ${errors.length} page errors` : ''}`)
  }
} finally {
  await browser?.close()
  await local.close()
}
writeFileSync(join(out, 'summary.json'), JSON.stringify({ label, throttled, profile: throttled ? PROFILE : null, sims, views, runs: summary }, null, 1))
console.log(`wrote ${out}`)
