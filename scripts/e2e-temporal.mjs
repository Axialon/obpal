/** Surface stability across the sim family. Measurements and optional captures always go to a fresh temporary folder. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { measureTemporal, prepareTemporal, temporalFailure } from './lib/temporal.mjs'
import { pressInWindow } from './lib/sim-ui.mjs'

export const TEMPORAL_SIMS = [
  ...['arm5', 'so101', 'six', 'scara', 'delta', 'desk'].map(kind => [`arm-${kind}`, `/sim/arm/?kind=${kind}`]),
  ['arena', '/sim/arena/'],
  ...['drone', 'rover', 'dog', 'ptz', 'studio', 'pinball', 'smarthome', 'planetary', 'jib', 'slider', 'trebuchet', 'pendulum',
    'telescope', 'marblerun', 'football', 'maze', 'lamp', 'claw', 'boat', 'spotlights', 'vacuum', 'tank', 'excavator', 'forklift',
    'painter', 'gimbal', 'plane', 'slotcars', 'sorting', 'kart', 'helicopter', 'submarine', 'airhockey'].map(id => [id, `/sim/device/?d=${id}`]),
  ['viewer', '/view/'],
]

export async function runTemporal(local, check, { ids = null, captures = [] } = {}) {
  const out = await mkdtemp(join(tmpdir(), 'obpal-temporal-'))
  const browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true })
  const results = []
  try {
    for (const [id, path] of TEMPORAL_SIMS.filter(([id]) => !ids || ids.includes(id))) {
      await check(`surfaces: ${id} holds at rest and does not flash during an orbit`, async () => {
        const context = await browser.newContext({ viewport: { width: 960, height: 640 }, ignoreHTTPSErrors: true })
        try {
          await prepareTemporal(context)
          const page = await context.newPage()
          await page.goto(`${local.origin}${path}${path.includes('?') ? '&' : '?'}test=vr&quality=native`)
          await page.waitForFunction(() => window.__presence, null, { timeout: 20000 })
          // Large environments have a public overview button; use it to see their floor, walls and props together. A
          // sim keeps it in its Controls window, which starts docked on this small screen: opened from the dock for it,
          // as a person would, and docked again.
          if (!(await pressInWindow(page, 'controls', 'Overview'))) {
            const overview = page.locator('button').filter({ hasText: /^Overview$/ }).filter({ visible: true })
            if (await overview.count()) await overview.last().click()
          }
          await page.waitForLoadState('networkidle')
          // Underwater caustics deliberately animate over the seabed with no input. Hold their clock,
          // keeping the shader and lighting drawn, so this check measures a genuinely static surface.
          if (id === 'submarine') await page.evaluate(() => {
            const caustics = window.__presence.experience.scene.getObjectByName('moving-caustics')
            const clock = caustics.material.uniforms.time
            Object.defineProperty(clock, 'value', { get: () => 0, set: () => {} })
          })
          const result = await measureTemporal(page, { captures: captures.includes(id) })
          if (id === 'submarine') result.heldAnimation = 'Underwater caustics clock at phase zero; shader and lighting remain enabled.'
          if (result.heatmap) {
            const dir = join(out, id); await mkdir(dir)
            await sharp(Buffer.from(result.heatmap.split(',')[1], 'base64')).flip().png().toFile(join(dir, 'heat.png'))
            for (const shot of result.shots) await writeFile(join(dir, `${shot.phase}-${String(shot.n).padStart(2, '0')}.png`), Buffer.from(shot.image.split(',')[1], 'base64'))
          }
          delete result.heatmap; delete result.shots
          const failure = temporalFailure(result)
          results.push({ id, failure, ...result })
          await writeFile(join(out, `${id}.json`), JSON.stringify(result, null, 2))
          if (failure) throw new Error(failure)
          const orbit = Math.max(...result.frames.filter(f => f.phase === 'orbit' && f.n > 1).map(f => f.p95))
          return `256 frames, ${Object.values(result.surfaces).reduce((a, b) => a + b, 0)} surface probes, orbit p95 ≤ ${orbit.toFixed(2)}/255`
        } finally { await context.close() }
      })
    }
    if (!ids || ids.includes('home')) await homeSurfaces(browser, local, check, out)
  } finally { await browser.close() }
  await writeFile(join(out, 'measurements.json'), JSON.stringify(results, null, 2))
  console.log(`  Surface measurements: ${out}`)
  return { out, results }
}

/** The home cards are SVG, with a 3D hero above them. Reduced motion holds their stories at rest; pointer input still plays them. */
async function homeSurfaces(browser, local, check, out) {
  const context = await browser.newContext({ viewport: { width: 960, height: 640 }, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
  try {
    await prepareTemporal(context)
    const page = await context.newPage()
    await page.goto(`${local.origin}/?quality=native`)
    await page.waitForLoadState('networkidle')
    await page.waitForFunction(() => document.documentElement.classList.contains('field3d') && window.__home && !window.__home.sim().busy, null, { timeout: 30000 })
    await page.evaluate(async () => { for (let n = 0; n < 120; n++) await new Promise(requestAnimationFrame) })
    await check('surfaces: the home hero holds its settled image for 64 frames', async () => {
      const result = await page.evaluate(async () => {
        const gl = document.querySelector('.hero-stage').getContext('webgl2')
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
        const pixels = new Uint8Array(w * h * 4), previous = new Uint8Array(pixels.length), frames = []
        for (let n = 0; n < 64; n++) {
          await new Promise(requestAnimationFrame)
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
          let max = 0, changed = 0, lit = 0
          for (let i = 0; i < pixels.length; i += 4) {
            const d = n ? Math.max(Math.abs(pixels[i] - previous[i]), Math.abs(pixels[i + 1] - previous[i + 1]), Math.abs(pixels[i + 2] - previous[i + 2])) : 0
            max = Math.max(max, d); if (d > 2) changed++; if (pixels[i] + pixels[i + 1] + pixels[i + 2]) lit++
          }
          frames.push({ n, max, changed, lit }); previous.set(pixels)
        }
        return { width: w, height: h, frames }
      })
      await writeFile(join(out, 'home-hero.json'), JSON.stringify(result, null, 2))
      if (result.frames.some(f => f.max > 2 || !f.lit)) throw new Error('the hero changed at rest or its framebuffer was empty')
      return '64 nonempty frames, ≤ 2/255 channel difference'
    })
    for (const id of ['arm', 'turn', 'point', 'play', 'together', 'desktop']) {
      await check(`surfaces: the home ${id} scene stays stable at rest and during input`, async () => {
        await page.locator(`[data-scene="${id}"]`).scrollIntoViewIfNeeded()
        const result = await page.evaluate(async id => {
          const host = document.querySelector(`[data-scene="${id}"]`), svg = host.querySelector('svg')
          const snapshots = [], frames = [], canvas = document.createElement('canvas')
          canvas.width = 400; canvas.height = 260
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          for (const phase of ['rest', 'moving']) for (let n = 0; n < 64; n++) {
            if (phase === 'moving') {
              const r = svg.getBoundingClientRect()
              host.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: r.x + r.width * (.5 + n * .0005), clientY: r.y + r.height * .4 }))
            }
            await new Promise(requestAnimationFrame)
            const copy = svg.cloneNode(true)
            copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); copy.setAttribute('width', '400'); copy.setAttribute('height', '260')
            snapshots.push({ phase, n, xml: new XMLSerializer().serializeToString(copy) })
          }
          host.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))
          let previous = null
          for (const snapshot of snapshots) {
            const image = new Image()
            image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(snapshot.xml)))}`
            await image.decode()
            ctx.clearRect(0, 0, 400, 260); ctx.drawImage(image, 0, 0)
            const pixels = ctx.getImageData(0, 0, 400, 260).data, differences = []
            let lit = 0
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i] + pixels[i + 1] + pixels[i + 2]) lit++
              if (previous) differences.push(Math.abs((pixels[i] - previous[i]) * .2126 + (pixels[i + 1] - previous[i + 1]) * .7152 + (pixels[i + 2] - previous[i + 2]) * .0722))
            }
            differences.sort((a, b) => a - b)
            frames.push({ phase: snapshot.phase, n: snapshot.n, lit, p95: differences[Math.floor(differences.length * .95)] ?? 0,
              mean: differences.reduce((sum, value) => sum + value, 0) / Math.max(1, differences.length) })
            previous = pixels
          }
          return { frames }
        }, id)
        await writeFile(join(out, `home-${id}.json`), JSON.stringify(result, null, 2))
        const bad = result.frames.find(f => !f.lit || f.phase === 'rest' && f.mean > .01 || f.phase === 'moving' && f.n > 2 && f.p95 > 8)
        if (bad) throw new Error(`${bad.phase} frame ${bad.n}: mean ${bad.mean.toFixed(2)}, p95 ${bad.p95.toFixed(2)}/255`)
        return '64 rest frames and 64 input frames, rasterized per pixel'
      })
    }
  } finally { await context.close() }
}
