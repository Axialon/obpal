/**
 * The first load of the sims that wear a Blender mesh (src/sim/kit/reveal.ts), on the local stand-in:
 *   - The mesh comes slowly (held back 0.8 s), in every sim that has one: every frame the sim draws while it waits shows
 *     the room and the loading pill, never the procedural rig; the mesh then comes in and the pill goes.
 *   - The mesh cannot come (its request refused): the procedural rig is shown at once, the sim still works, and the pill
 *     goes.
 *   - The mesh takes longer than the budget (6.5 s against 4 s): the procedural rig is shown when the budget is up, and
 *     the mesh takes its place when it does arrive.
 *   - What a phone does before the mesh arrives is in the model when it does.
 *   - The finished device eases in (a little smaller to full size in about 320 ms), and does not move at all for a visitor
 *     who asked for less motion.
 *   - The mesh is fetched once, by the preload in the page.
 * The page records every frame it draws when it is opened with ?test=load: whether a held rig's procedural model was
 * in it (window.__loadFrames). Called by e2e-sims.mjs with the stand-in and its `check`.
 */
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 10000, every = 50) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(every)
  }
}

/** Every sim that wears a mesh, from the table the pages read (src/sim/kit/models.ts): a name, the page a visitor opens, and its mesh. */
const table = await readFile(new URL('../src/sim/kit/models.ts', import.meta.url), 'utf8')
const devices = [...table.match(/DEVICE_MODELS[^=]*= \{([\s\S]*?)\n\}/)[1].matchAll(/([a-z]+): \['([a-z-]+)'\]/g)].map(([, id, model]) => [id, `/sim/${id}/`, model])
const arms = [...table.match(/ARM_MODELS[^=]*= \[([^\]]*)\]/)[1].matchAll(/'([a-z0-9]+)'/g)].map(([, kind]) => [`arm ${kind}`, `/sim/arm/?kind=${kind}`, kind])
export const LOAD_SIMS = [...arms, ...devices]

export async function runLoad(local, check, { executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined } = {}) {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    /**
     * A page on `path`, with the mesh's request handled by `mode`: { abort } refuses it; { hold: ms } lets it go that
     * long after the sim has begun to hold its rig; { wait: ms } that long after the request is made. { context }: more
     * options for the browser context.
     */
    async function open(path, model, mode = {}) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, ...mode.context })
      // Whether the pill was ever up, whatever moment the test looks.
      await context.addInitScript(() => {
        window.__pillSeen = false
        setInterval(() => { const el = document.getElementById('sim-load'); if (el && !el.hidden) window.__pillSeen = true }, 20)
      })
      const page = await context.newPage()
      if (mode.abort) await context.route(`**/models/${model}.glb`, (route) => route.abort())
      else if (mode.hold || mode.wait) await context.route(`**/models/${model}.glb`, async (route) => {
        if (mode.hold) await until('the sim to hold its rig', () => page.evaluate((ready) => window.__rigs?.().created > 0 && (!ready || !!window.__device?.logic), !!mode.ready).catch(() => false), 30000).catch(() => {})
        await sleep(mode.hold ?? mode.wait)
        await route.continue()
      })
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${local.origin}${path}${path.includes('?') ? '&' : '?'}test=load&quality=native`)
      // The sim is up once its first rig is held (or, for a sim that fell back at once, shown).
      await until('a rig held', () => page.evaluate(() => window.__rigs?.().created > 0), 30000)
      return { context, page, errors }
    }
    const report = (page, model) => page.evaluate((model) => {
      const mark = (n) => performance.getEntriesByName(`obpal:${model}:${n}`)[0]?.startTime ?? null
      return { frames: window.__loadFrames ?? [], rigs: window.__rigs(), held: mark('held'), load: mark('load'), visible: mark('visible'), pill: (() => { const el = document.getElementById('sim-load'); return !!el && !el.hidden })() }
    }, model)

    for (const [name, path, model] of LOAD_SIMS) {
      await check(`first load, ${name}: the mesh comes slowly and no drawn frame shows the procedural rig`, async () => {
        const { context, page, errors } = await open(path, model, { hold: 800 })
        try {
          await until('the mesh installed', () => page.evaluate((m) => performance.getEntriesByName(`obpal:${m}:visible`).length > 0, model), 30000)
          await sleep(600)
          const r = await report(page, model)
          const waiting = r.frames.filter((f) => f.loading), withStandIn = r.frames.filter((f) => f.standIn)
          if (waiting.length < 3) throw new Error(`only ${waiting.length} frames were drawn while it waited`)
          if (withStandIn.length) throw new Error(`${withStandIn.length} of ${r.frames.length} drawn frames showed the procedural rig`)
          if (r.rigs.standIn || r.rigs.held) throw new Error(`afterwards: ${JSON.stringify(r.rigs)}`)
          if (!await page.evaluate(() => window.__pillSeen)) throw new Error('no loading pill while the mesh was on its way')
          await until('the pill gone', () => page.evaluate(() => document.getElementById('sim-load').hidden), 3000)
          if (errors.length) throw new Error(errors.join(' | '))
          return `${waiting.length} frames while it waited, ${r.frames.length} in all, none with the stand-in`
        } finally { await context.close() }
      })
    }

    for (const [name, path, model] of LOAD_SIMS.filter(([n]) => ['arm so101', 'drone', 'kart', 'dog'].includes(n))) {
      await check(`first load, ${name}: the mesh cannot come, and the procedural rig is shown at once`, async () => {
        const { context, page, errors } = await open(path, model, { abort: true })
        try {
          await until('a frame with the procedural rig', () => page.evaluate(() => (window.__loadFrames ?? []).some((f) => f.standIn)), 5000)
          await sleep(300)
          const r = await report(page, model)
          if (r.visible !== null) throw new Error('the mesh was reported installed')
          if (!r.frames.some((f) => f.standIn)) throw new Error('no drawn frame showed the procedural rig')
          if (r.frames.some((f) => f.standIn && f.loading)) throw new Error('a frame showed both the pill and the procedural rig')
          await until('the pill gone', () => page.evaluate(() => document.getElementById('sim-load').hidden), 3000)
          // Still a working sim: the model steps and the page has no errors.
          const alive = await page.evaluate(() => !!(window.__arm ?? window.__device))
          if (!alive) throw new Error('the sim did not come up')
          if (errors.length) throw new Error(errors.join(' | '))
          return `${r.frames.filter((f) => f.standIn).length} frames with the stand-in, after ${Math.round(r.frames.find((f) => f.standIn).t - r.load)} ms of waiting`
        } finally { await context.close() }
      })
    }

    for (const reduced of [false, true]) {
      await check(`first load, drone: the finished drone ${reduced ? 'appears without moving for a visitor who asked for less motion' : 'eases in from a little smaller, and is not just swapped in'}`, async () => {
        const { context, page, errors } = await open('/sim/drone/', 'drone', { hold: 800, context: { reducedMotion: reduced ? 'reduce' : 'no-preference' } })
        try {
          await until('the mesh installed', () => page.evaluate(() => performance.getEntriesByName('obpal:drone:visible').length > 0), 30000)
          await sleep(900)
          const r = await report(page, 'drone')
          const after = r.frames.filter((f) => f.t >= r.visible && f.scale !== null)
          if (after.length < 3) throw new Error(`only ${after.length} frames were drawn after the mesh came`)
          const final = after.at(-1).scale, ratios = after.map((f) => f.scale / final)
          if (reduced) {
            if (ratios.some((k) => Math.abs(k - 1) > 1e-9)) throw new Error(`it moved: from ${Math.min(...ratios).toFixed(3)} of its size`)
            return 'full size from its first frame'
          }
          const smaller = after.filter((f, i) => ratios[i] < 0.999)
          if (!smaller.length) throw new Error('it appeared at full size at once')
          if (Math.min(...ratios) < 0.9) throw new Error(`it started at ${Math.min(...ratios).toFixed(3)} of its size`)
          if (ratios.some((k, i) => i && k < ratios[i - 1] - 1e-9)) throw new Error('it did not grow steadily')
          const span = smaller.at(-1).t - smaller[0].t
          if (span > 600) throw new Error(`the entrance lasted ${Math.round(span)} ms`)
          if (errors.length) throw new Error(errors.join(' | '))
          return `from ${Math.min(...ratios).toFixed(2)} of its size to full over ${Math.round(span)} ms, ${smaller.length} frames`
        } finally { await context.close() }
      })
    }

    await check('first load, rover: a mesh past the budget gives way to the procedural rig, and takes its place when it comes', async () => {
      const { context, page, errors } = await open('/sim/rover/', 'rover', { wait: 6500 })
      try {
        await until('a frame with the procedural rig', () => page.evaluate(() => (window.__loadFrames ?? []).some((f) => f.standIn)), 8000)
        const at = await report(page, 'rover')
        const first = at.frames.find((f) => f.standIn)
        const waited = first.t - at.load
        if (waited < 3500 || waited > 6000) throw new Error(`gave way after ${Math.round(waited)} ms; the budget is 4000`)
        if (at.frames.some((f) => f.t < first.t && f.standIn)) throw new Error('a frame showed the procedural rig early')
        await until('the mesh installed', () => page.evaluate(() => performance.getEntriesByName('obpal:rover:visible').length > 0), 20000)
        await sleep(600)
        const r = await report(page, 'rover')
        if (r.rigs.standIn) throw new Error('the procedural rig stayed after the mesh came')
        if (errors.length) throw new Error(errors.join(' | '))
        return `gave way after ${Math.round(waited)} ms; the mesh took its place ${Math.round(r.visible - first.t)} ms later`
      } finally { await context.close() }
    })

    await check('first load, drone: what a phone does before the mesh arrives is in the model when it does', async () => {
      const { context, page, errors } = await open('/sim/drone/', 'drone', { hold: 1500, ready: true })
      try {
        await until('the sim', () => page.evaluate(() => !!window.__device?.logic), 30000)
        // The drone takes off while its mesh is still on its way.
        await page.evaluate(() => { window.__device.logic.drones[0].phase = 'takeoff' })
        await sleep(1200)
        const before = await page.evaluate(() => ({ y: window.__device.logic.drones[0].y, mesh: performance.getEntriesByName('obpal:drone:visible').length }))
        if (before.mesh) throw new Error('the mesh came before the drone took off')
        if (!(before.y > 0.05)) throw new Error(`the drone did not lift (${before.y})`)
        await until('the mesh installed', () => page.evaluate(() => performance.getEntriesByName('obpal:drone:visible').length > 0), 20000)
        await sleep(700)
        const after = await page.evaluate(() => {
          const d = window.__device, drone = d.logic.drones[0]
          const root = d.stage.scene.children.find((o) => o.userData.prototype === 'blender')
          return { y: drone.y, x: drone.x, z: drone.z, at: root ? root.position.toArray() : null, scale: root ? root.scale.toArray() : null, visible: root?.visible }
        })
        if (!after.at || !after.visible) throw new Error(`no mesh drone in view: ${JSON.stringify(after)}`)
        if (Math.abs(after.at[1] - after.y) > 0.02 || Math.abs(after.at[0] - after.x) > 0.02 || Math.abs(after.at[2] - after.z) > 0.02) throw new Error(`the mesh drone is at ${after.at.map((v) => v.toFixed(2))}, the drone at ${[after.x, after.y, after.z].map((v) => v.toFixed(2))}`)
        if (after.scale.some((s) => Math.abs(s - 1) > 1e-6)) throw new Error(`the entrance left the scale at ${after.scale}`)
        if (errors.length) throw new Error(errors.join(' | '))
        return `the mesh appeared with the drone ${after.y.toFixed(2)} m up, at full size`
      } finally { await context.close() }
    })

    await check('first load: the mesh is fetched once, by the page\'s preload, ahead of the rig', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
      try {
        const page = await context.newPage()
        await page.goto(`${local.origin}/sim/drone/?test=load`)
        await until('the mesh installed', () => page.evaluate(() => performance.getEntriesByName('obpal:drone:visible').length > 0), 30000)
        const glb = () => page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /\/models\/drone\.glb/.test(r.name)).map((r) => ({ initiator: r.initiatorType, start: r.startTime })))
        const first = await glb()
        if (first.length !== 1) throw new Error(`${first.length} requests for the mesh: ${JSON.stringify(first)}`)
        if (first[0].initiator !== 'link') throw new Error(`the page's request was not the preload's (${first[0].initiator})`)
        const held = await page.evaluate(() => performance.getEntriesByName('obpal:drone:held')[0].startTime)
        if (first[0].start >= held) throw new Error('the download began only once the rig existed')
        return `one request, from the page's preload, ${Math.round(held - first[0].start)} ms before the rig existed`
      } finally { await context.close() }
    })
  } finally { await browser.close() }
}
