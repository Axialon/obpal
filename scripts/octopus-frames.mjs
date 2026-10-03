/**
 * Octopus motion evidence from the live device page: scripted phone-equivalent input (or none, for the showcase) at
 * fixed timestamps, saved as frames and one labelled strip per scenario. The e2e group (./e2e-octopus.mjs) calls
 * `captureOctopus`; run this file directly for review captures into an ignored folder:
 *   OBPAL_E2E_PORT=<stand-in> OBPAL_E2E_WORKER_PORT=<worker> node scripts/octopus-frames.mjs artifacts/octopus/after
 * It needs a current build (vite build) and holds a shared GPU slot while it draws.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'

/** Driven scenario: seconds since load, then what the phone does from there. Axes are a gamepad's left stick. */
export const DRIVEN = [
  { at: 1.5, label: 'rest' },
  { at: 3.5, label: 'idle life' },
  { at: 4.0, axes: [0, -1], label: 'crawl starts' },
  { at: 5.0, label: 'crawl' },
  { at: 6.2, label: 'crawl, stepping' },
  { at: 7.0, axes: [-0.9, -0.3], label: 'turning' },
  { at: 8.4, axes: [0, 0], presses: ['pulse'], label: 'pulse' },
  { at: 8.7, label: 'push-off' },
  { at: 9.8, presses: ['curl'], label: 'curl' },
  { at: 11.0, label: 'curled' },
  { at: 12.4, presses: ['curl'], label: 'uncurl' },
  { at: 13.6, label: 'planted again' },
]
/** The showcase: nobody holds it, so after six seconds it seeks the ball, carries it to the ring, curls and pulses. */
export const SHOWCASE = [7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29].map((at) => ({ at, label: `showcase ${at} s` }))

/** Replace unit 0's input with a scripted gamepad, so captures need no paired phone. Test-only: nothing ships it. */
async function script(page) {
  await page.evaluate(() => {
    const device = window.__device, step = device.logic.step.bind(device.logic)
    window.__octopusScript = { axes: [0, 0], presses: [] }
    device.logic.step = (inputs, dt) => {
      const s = window.__octopusScript
      const input = {
        face: 'face.gamepad', mode: 1, pad: { axes: [s.axes[0], s.axes[1], 0, 0], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 },
        padPressed: 0, touching: false, drag: [0, 0], pan: [0, 0], pinch: 0, twist: 0, tilt: [0, 0], hold: null, point: null,
        spot: null, pose: null, held: new Set(), presses: s.presses.splice(0), wheel: 0, text: '', del: 0, values: [], recentred: false,
      }
      return step([input, ...inputs.slice(1)], dt)
    }
  })
}

/** Keep the camera on the octopus from the play framing's angle, as a holder's view would follow it. */
async function follow(page) {
  await page.evaluate(() => {
    const { stage, logic } = window.__device, u = logic.units[0]
    stage.follow(stage.camera.position.clone().set(u.x, 0.22, u.z))
  })
}

export async function openOctopus(page, origin, { width = 1440, height = 900 } = {}) {
  await page.setViewportSize({ width, height })
  await page.goto(`${origin}/sim/octopus/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__device?.logic && window.__gfx?.().triangles > 0, null, { timeout: 30000 })
  const pairing = page.getByRole('button', { name: 'Scan to control', exact: true })
  if (await pairing.count() && await pairing.getAttribute('aria-expanded') === 'true') await pairing.click()
  await page.mouse.move(4, 4)
}

/** Run one scenario from a fresh load and return its frames' paths and the logic's state at each. */
export async function captureOctopus(page, origin, out, { scenario = DRIVEN, name = 'driven', width = 1440, height = 900, driven = true } = {}) {
  await openOctopus(page, origin, { width, height })
  if (driven) await script(page)
  await mkdir(join(out, `${name}-frames`), { recursive: true })
  const start = await page.evaluate(() => performance.now())
  const frames = []
  for (const [i, step] of scenario.entries()) {
    const now = await page.evaluate(() => performance.now())
    const wait = step.at * 1000 - (now - start)
    if (wait > 0) await page.waitForTimeout(wait)
    if (driven) await page.evaluate(({ axes, presses }) => {
      const s = window.__octopusScript
      if (axes) s.axes = axes
      if (presses) s.presses.push(...presses)
    }, { axes: step.axes, presses: step.presses })
    await follow(page)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const path = join(out, `${name}-frames`, `${String(i).padStart(2, '0')}.png`)
    await page.screenshot({ path })
    const state = await page.evaluate(() => {
      const u = window.__device.logic.units[0]
      return { x: u.x, y: u.y, z: u.z, h: u.h, v: u.v, mode: u.mode, roles: u.roles.join(','), mantle: u.mantle, held: u.ball.held, showing: u.showing, readout: window.__device.logic.readout(0) }
    })
    frames.push({ path, label: step.label, at: step.at, state })
  }
  await strip(frames, join(out, `${name}-strip.png`))
  await writeFile(join(out, `${name}.json`), JSON.stringify({ name, width, height, frames }, null, 2) + '\n')
  return frames
}

/** A labelled contact strip: identical cells, four across, each captioned with its label and time. */
export async function strip(frames, path, { cell = [480, 300], across = 4 } = {}) {
  const [w, h] = cell, rows = Math.ceil(frames.length / across), label = 28
  const cells = await Promise.all(frames.map(async (frame, i) => {
    const image = await sharp(frame.path).resize(w, h, { fit: 'cover' }).png().toBuffer()
    const text = `${frame.label} · ${frame.at.toFixed(1)} s`.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const caption = Buffer.from(`<svg width="${w}" height="${label}"><rect width="100%" height="100%" fill="#101418"/><text x="10" y="19" font-family="Segoe UI, Arial, sans-serif" font-size="15" fill="#e6ebf2">${text}</text></svg>`)
    return [
      { input: image, left: (i % across) * w, top: Math.floor(i / across) * (h + label) + label },
      { input: caption, left: (i % across) * w, top: Math.floor(i / across) * (h + label) },
    ]
  }))
  await sharp({ create: { width: w * across, height: rows * (h + label), channels: 3, background: '#101418' } })
    .composite(cells.flat()).png().toFile(path)
}

async function free(port) {
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2]
  if (!out || !out.replaceAll('\\', '/').startsWith('artifacts/')) throw new Error('Give an output folder under artifacts/')
  for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
    if (!Number(process.env[key])) throw new Error(`${key} is required`)
    await free(Number(process.env[key]))
  }
  const { chromium } = await import('playwright')
  const { e2eBrowserOptions, resolveChromium } = await import('./lib/browser.mjs')
  const { acquireGpuLease } = await import('./lib/gpu-lease.mjs')
  const { startLocal } = await import('../extension/e2e/local.mjs')
  const release = process.env.OBPAL_E2E_GPU === '1' ? await acquireGpuLease({ mode: 'shared', suite: 'octopus-frames' }) : null
  const local = await startLocal()
  const executablePath = (await resolveChromium()).path || undefined
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath, headless: true, args: ['--ignore-certificate-errors'] }))
  try {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true, deviceScaleFactor: 1 })).newPage()
    const errors = []
    page.on('pageerror', (e) => { if (errors.length < 5) errors.push(e.stack ?? e.message) })
    const only = process.env.OCTOPUS_SCENARIO
    if (!only || only === 'driven') await captureOctopus(page, local.origin, out)
    if (!only || only === 'showcase') await captureOctopus(page, local.origin, out, { scenario: SHOWCASE, name: 'showcase', driven: false })
    if (!only || only === 'phone') await captureOctopus(page, local.origin, out, { scenario: DRIVEN.slice(0, 6), name: 'phone', width: 390, height: 844 })
    if (errors.length) throw new Error(errors.join('\n'))
    console.log(`Octopus frames in ${out}`)
  } finally {
    await browser.close()
    await local.close()
    await release?.()
  }
}
