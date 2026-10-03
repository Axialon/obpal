/**
 * Review strips of BODY driving Keel: a synthetic person on Keel's proportions faces the camera with light landmark
 * noise and turns, leans and raises an arm, through the loopback BODY seam (real BODY encoding, BodyInput,
 * retargeting, tendons and skins). The same script runs against any build, so before and after strips match.
 *
 *   pnpm exec vite build && node scripts/humanoid-body-strips.mjs <evidence folder> <label>
 *   OBPAL_STRIPS_DIST=<other checkout>/dist/client node scripts/humanoid-body-strips.mjs <evidence folder> before
 *
 * Needs OBPAL_E2E_PORT and OBPAL_E2E_WORKER_PORT; takes the shared GPU lease like the e2e runner. Writes only the
 * composed strips and a metrics JSON into the evidence folder.
 */
import { chromium } from 'playwright'
import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { e2eBrowserOptions, resolveChromium } from './lib/browser.mjs'
import { acquireGpuLease } from './lib/gpu-lease.mjs'

const out = resolve(process.argv[2] ?? 'artifacts/f1c/strips'),
  label = process.argv[3] ?? 'build'
for (const k of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) if (!process.env[k]) throw new Error(`Set ${k}`)
const SCENES = ['stand', 'turn', 'lean', 'arm']
/** Seconds after the scene starts; calibration takes the first second. */
const TIMES = [0.9, 1.6, 2.2, 2.8, 3.4, 4.0, 4.6]

/** In the page: a seeded, camera-facing person injected at 30 Hz into seat 1. */
function drive({ scene, gen }) {
  const h = window.__humanoid,
    p = h.actors[0].rig.profile,
    root = h.actors[0].rig.root
  const V = root.position.constructor,
    Q = root.quaternion.constructor
  let seed = 17
  const noise = (s) => ((seed = (seed * 16807) % 2147483647) / 2147483647 * 2 - 1) * s
  const ease = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)))
  const rad = Math.PI / 180
  const person = (t) => {
    const q = { 'left.arm.roll': 25 * rad, 'right.arm.roll': 25 * rad, 'left.arm.elbow': 15 * rad, 'right.arm.elbow': 15 * rad }
    let heading = 0
    if (scene === 'turn') heading = 45 * rad * (ease(t, 1.2, 2.2) - ease(t, 3.2, 4.2))
    if (scene === 'lean') {
      q['spine.pitch'] = -18 * rad * (ease(t, 1.2, 2.0) - ease(t, 2.6, 3.0))
      q['spine.roll'] = 15 * rad * ease(t, 3.0, 3.8)
    }
    if (scene === 'arm') {
      q['left.arm.roll'] = 25 * rad * (1 - ease(t, 1.2, 2.0))
      q['left.arm.pitch'] = 130 * rad * ease(t, 1.2, 3.2)
    }
    return { q, heading }
  }
  const body = (t) => {
    const { q, heading } = person(t),
      fk = new Map()
    for (const j of p.joints) {
      const parent = fk.get(j.parent),
        r = parent?.q.clone() ?? new Q(),
        at = new V(...j.offset).applyQuaternion(r).add(parent?.p ?? new V())
      r.multiply(new Q().setFromAxisAngle(new V(...j.axis), q[j.id] ?? 0))
      fk.set(j.id, { p: at, q: r })
    }
    const hip = fk.get(p.root).p,
      turn = new Q().setFromAxisAngle(new V(0, 1, 0), Math.PI + heading),
      landmarks = Array.from({ length: 33 }, () => [0, 0, 0])
    const at = (id, offset = [0, 0, 0]) => {
      const v = new V(...offset).applyQuaternion(fk.get(id).q).add(fk.get(id).p).sub(hip).applyQuaternion(turn)
      return [v.x + noise(0.006), v.y + noise(0.006), v.z + noise(0.015)]
    }
    for (const c of p.chains) {
      landmarks[c.points[0]] = at(c.joints[0])
      landmarks[c.points[1]] = at(c.joints[3])
      landmarks[c.points[2]] = at(c.end)
      if (c.group === 'arms') {
        landmarks[c.tips[0]] = at(c.end, [-0.025, -0.1, 0])
        landmarks[c.tips[1]] = at(c.end, [0.025, -0.1, 0])
      } else {
        landmarks[c.tips[0]] = at(c.end, [0, -0.05, 0.09])
        landmarks[c.tips[1]] = at(c.end, [0, -0.05, -0.18])
      }
    }
    landmarks[0] = at(p.frame.head[1], [0, 0.08, -0.12])
    landmarks[7] = at(p.frame.head[1], [-0.08, 0.08, 0])
    landmarks[8] = at(p.frame.head[1], [0.08, 0.08, 0])
    return landmarks
  }
  const start = performance.now(),
    log = []
  let seq = 0
  window.__strip = { start, log }
  window.__stripTimer = setInterval(() => {
    const t = (performance.now() - start) / 1000
    h.inject(0, {
      flags: 1,
      seq: ++seq & 65535,
      t: Math.round(performance.now() * 1000) >>> 0,
      gen,
      landmarks: body(t),
      visibility: Array(33).fill(1),
      presence: Array(33).fill(1),
    })
    const a = h.actors[0]
    log.push({ t, q: { ...a.control.q }, facing: a.control.facing ?? a.control.yaw, yaw: a.control.yaw })
  }, 33)
}

const browserPath = (await resolveChromium()).path || undefined
const release = process.env.OBPAL_E2E_GPU === '1' ? await acquireGpuLease({ mode: 'shared', suite: 'humanoid-strips', lane: 'f1c' }) : null
// OBPAL_STRIPS_DIST serves another build's client output, such as a master checkout's, for the before strips.
const { startLocal } = await import('../extension/e2e/local.mjs'),
  local = await startLocal(process.env.OBPAL_STRIPS_DIST ? { dist: resolve(process.env.OBPAL_STRIPS_DIST) } : {})
const browser = await chromium.launch(e2eBrowserOptions({ executablePath: browserPath, headless: true, args: ['--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] }))
const summary = { label, renderer: '', scenes: {} }
try {
  await mkdir(out, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await page.goto(`${local.origin}/sim/humanoid/?test=humanoid`)
  await page.waitForFunction(() => window.__humanoid && window.__humanoid.actors.every((a) => a.rig.root.userData.prototype === 'blender'), null, { timeout: 30000 })
  // The pairing card would cover the robot in a crop; the scene itself is unchanged.
  await page.addStyleTag({ content: '.obpal-card{visibility:hidden!important}' })
  summary.renderer = await page.evaluate(() => {
    const gl = document.querySelector('#stage').getContext('webgl2'),
      info = gl.getExtension('WEBGL_debug_renderer_info')
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'Unavailable'
  })
  const rows = []
  for (const [index, scene] of SCENES.entries()) {
    await page.evaluate(() => {
      clearInterval(window.__stripTimer)
      window.__humanoid.clear(0)
    })
    await page.waitForTimeout(900)
    await page.evaluate(() => {
      const h = window.__humanoid,
        a = h.actors[0]
      a.control.position.set(-0.65, 0, 0)
      a.control.yaw = -Math.PI / 2
      h.camera.position.set(2.5, 2, -5)
    })
    await page.evaluate(drive, { scene, gen: index + 1 })
    const begin = Date.now()
    let clip = null
    const cells = []
    for (const time of TIMES) {
      const wait = begin + time * 1000 - Date.now()
      if (wait > 0) await page.waitForTimeout(wait)
      if (!clip) {
        const points = await page.evaluate(() => {
          const h = window.__humanoid,
            a = h.actors[0]
          a.rig.root.updateMatrixWorld(true)
          const head = a.rig.point('head.pitch')
          head.y += 0.3
          return [...a.rig.profile.joints.map((j) => a.rig.point(j.id)), head].map((p) => {
            const n = p.project(h.camera)
            return { x: ((n.x + 1) / 2) * innerWidth, y: ((1 - n.y) / 2) * innerHeight }
          })
        })
        const xs = points.map((p) => p.x), ys = points.map((p) => p.y)
        const w = Math.max(...xs) - Math.min(...xs), hgt = Math.max(...ys) - Math.min(...ys)
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2, top = Math.min(...ys) - hgt * 0.3
        const size = Math.round(Math.max(w * 2.4, hgt * 1.45))
        clip = { x: Math.max(0, Math.round(cx - size / 2)), y: Math.max(0, Math.round(top)), width: size, height: Math.round(size * 1.05) }
        clip.width = Math.min(clip.width, 1440 - clip.x)
        clip.height = Math.min(clip.height, 900 - clip.y)
      }
      cells.push({ time, png: await page.screenshot({ clip }) })
    }
    const log = await page.evaluate(() => window.__strip.log)
    const deg = (n) => (n * 180) / Math.PI
    // The largest change between samples, from 1.2 s: acquisition shows the first pose at once, by design.
    const worst = (keep) => {
      let value = 0,
        joint = ''
      for (let i = 1; i < log.length; i++)
        if (log[i - 1].t > 1.2)
          for (const id of Object.keys(log[i].q).filter(keep)) {
            const s = Math.abs(log[i].q[id] - log[i - 1].q[id])
            if (s > value) [value, joint] = [s, id]
          }
      return { value: deg(value), joint }
    }
    const step = worst(() => true),
      body = worst((id) => !id.includes('.wrist.'))
    const most = (ids) => Math.max(...log.filter((f) => f.t > 1).flatMap((f) => ids.map((id) => Math.abs(deg(f.q[id] ?? 0)))))
    summary.scenes[scene] = {
      samples: log.length,
      maxLegYawDeg: most(['left.leg.yaw', 'right.leg.yaw']),
      maxArmYawDeg: most(['left.arm.yaw', 'right.arm.yaw']),
      maxArmRollDeg: most(['left.arm.roll', 'right.arm.roll']),
      maxStepDeg: step.value,
      maxStepJoint: step.joint,
      // Wrists read a 5 cm hand from unfiltered strip noise; the phone's capture filter is not in this seam.
      maxStepExceptWristsDeg: body.value,
      maxStepExceptWristsJoint: body.joint,
      facingRangeDeg: [Math.min(...log.map((f) => deg(f.facing - f.yaw))), Math.max(...log.map((f) => deg(f.facing - f.yaw)))],
      peakArmPitchDeg: Math.max(...log.map((f) => Math.max(deg(f.q['left.arm.pitch']), deg(f.q['right.arm.pitch'])))),
      spinePitchRangeDeg: [Math.min(...log.map((f) => deg(f.q['spine.pitch']))), Math.max(...log.map((f) => deg(f.q['spine.pitch'])))],
    }
    rows.push({ scene, cells })
  }
  // One sheet: a row per scene, a column per time, identical cell sizes and captions.
  const cell = 220,
    caption = 22
  const composites = []
  for (const [r, row] of rows.entries())
    for (const [c, { time, png }] of row.cells.entries()) {
      const image = await sharp(png).resize(cell, cell, { fit: 'contain', background: '#0f1418' }).png().toBuffer()
      composites.push({ input: image, left: c * cell, top: r * (cell + caption) + caption })
      const text = `${label} · ${row.scene} · ${time.toFixed(1)} s`
      composites.push({
        input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${caption}"><rect width="100%" height="100%" fill="#0f1418"/><text x="6" y="16" font-family="Arial" font-size="12" fill="#c6ff34">${text}</text></svg>`),
        left: c * cell,
        top: r * (cell + caption),
      })
    }
  await sharp({ create: { width: cell * TIMES.length, height: rows.length * (cell + caption), channels: 3, background: '#0f1418' } })
    .composite(composites)
    .png()
    .toFile(join(out, `strips-${label}.png`))
  await writeFile(join(out, `strips-${label}.json`), JSON.stringify({ ...summary, times: TIMES, viewport: '1440x900', camera: [2.5, 2, -5], mirror: true }, null, 2))
  console.log(JSON.stringify(summary, null, 2))
} finally {
  await browser.close()
  await local.close()
  await release?.()
}
