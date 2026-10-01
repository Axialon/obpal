/** Emulated layouts and sensor events supplement the fixed-clock and existing phone control gates. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function runMarbleMobile(browser, local, check, out) {
  for (const [width, height] of [[360, 800], [390, 844], [430, 932], [800, 360], [844, 390], [932, 430], [1440, 900]]) {
    await check(`marblerun ${width}x${height}: both boards' companions draw, entrance settles and tilt responds`, async () => {
      const mobile = width !== 1440
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 2, ignoreHTTPSErrors: true })
      const rows = []
      try {
        if (mobile) await context.addInitScript(() => {
          DeviceOrientationEvent.requestPermission = async () => 'granted'
          if (window.DeviceMotionEvent) DeviceMotionEvent.requestPermission = async () => 'granted'
        })
        const page = await context.newPage()
        await page.goto(`${local.origin}/sim/marblerun/?test=vr`)
        await page.waitForFunction(() => window.__device?.logic)
        await page.evaluate(() => window.__sim.chip.collapse())
        const sequence = await page.evaluate(async () => {
          const { logic } = window.__device
          logic.home(0)
          const start = performance.now(), samples = []; let previous = logic.renderState()[0].marbles, maxJump = 0
          while (logic.units[0].start.phase !== 'settled' && performance.now() - start < 4000) {
            await new Promise(requestAnimationFrame)
            const pose = logic.renderState()[0].marbles
            pose.forEach((m, j) => { maxJump = Math.max(maxJump, Math.hypot(m.x - previous[j].x, m.z - previous[j].z)) })
            previous = pose; samples.push({ t: performance.now() - start, elapsed: logic.units[0].start.elapsed, phase: logic.units[0].start.phase, pose })
          }
          return { samples, maxJump, elapsed: logic.units[0].start.elapsed, wallMs: performance.now() - start, bodies: [logic.units[0], ...logic.units[0].marbles].map(m => ({ x: m.x, z: m.z, vx: m.vx, vz: m.vz })) }
        })
        rows.push({ sequence })
        if (sequence.elapsed < 1.5 || sequence.elapsed > 2.5 || sequence.wallMs > 3100 || sequence.maxJump > .06 || sequence.bodies.some(m => Math.hypot(m.x + 1.16, m.z) > .16 || Math.hypot(m.vx, m.vz) > .001)) throw new Error(`Entrance missed its budget: ${JSON.stringify(sequence)}`)
        for (const board of [1, 2]) {
          const visibility = await page.evaluate(async board => {
            const { stage } = window.__device
            const root = stage.scene.getObjectByName(`track-pedestal-${board}`)
            window.__marbleFrame ??= stage.onFrame
            stage.onFrame = (...args) => { window.__marbleFrame(...args); stage.follow(root.position.clone().setY(.9)) }
            const marbles = []
            root.traverse(o => { if (o.name === 'marble' || o.name.startsWith('companion-marble-')) marbles.push(o) })
            const drawn = new Set(), hooks = marbles.map(mesh => { const original = mesh.onBeforeRender; mesh.onBeforeRender = function(...args) { drawn.add(mesh.name); original.apply(this,args) }; return {mesh,original} })
            stage.view.invalidate(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)
            stage.scene.updateMatrixWorld(true)
            const rows = marbles.map(mesh => {
              const at = mesh.getWorldPosition(mesh.position.clone()), centre = stage.toScreen(at)
              const edge = stage.toScreen(at.clone().add(at.clone().set(mesh.geometry.parameters.radius,0,0).applyQuaternion(stage.camera.quaternion)))
              const radius = Math.hypot(edge.x-centre.x, edge.y-centre.y)
              let visible = true; for(let o=mesh;o;o=o.parent) visible &&= o.visible
              return {name:mesh.name,drawn:drawn.has(mesh.name),visible,centre,radius}
            })
            hooks.forEach(({mesh,original}) => {mesh.onBeforeRender=original})
            return rows
          }, board)
          rows.push({ board, visibility })
          if (visibility.length !== 3 || visibility.some(m => !m.drawn || !m.visible || m.radius < 3 || m.centre.x-m.radius < 0 || m.centre.x+m.radius > width || m.centre.y-m.radius < 0 || m.centre.y+m.radius > height)) throw new Error(`Marbles are cropped or too small: ${JSON.stringify(visibility)}`)
          await page.screenshot({ path: join(out, `marble-screen-${width}x${height}-board-${board}.png`) })
          await page.evaluate(() => { window.__device.stage.onFrame = window.__marbleFrame })
        }
        if (mobile) {
          const controls = await page.locator('.marble-phone button').evaluateAll(buttons => buttons.map(b => { const r = b.getBoundingClientRect(); return { x:r.x, right:r.right, width:r.width, height:r.height } }))
          if (controls.some(b => b.width < 44 || b.height < 44 || b.x < 0 || b.right > width)) throw new Error(`Phone controls are too small or cropped: ${JSON.stringify(controls)}`)
          await page.locator('.marble-motion').click()
          const orient = gamma => page.evaluate(gamma => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha:0,beta:60,gamma })), gamma)
          await orient(0); await orient(35)
          await page.waitForFunction(() => Math.abs(window.__device.logic.units[0].tiltX) > .12)
          if (await page.locator('.marble-motion').getAttribute('aria-pressed') !== 'true') throw new Error('Tilt is not shown active')
          await page.locator('[data-marble=recentre]').click()
          await page.waitForFunction(() => Math.abs(window.__device.logic.units[0].tiltX) < .001)
          await orient(0)
          await page.waitForFunction(() => Math.abs(window.__device.logic.units[0].tiltX) > .12)
          const actions = await page.evaluate(() => window.__device.logic.units[0].actions)
          await page.mouse.move(width / 2, height / 2); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up()
          await page.waitForFunction(() => Math.abs(window.__device.logic.units[0].tiltX) < .001)
          if (await page.evaluate(() => window.__device.logic.units[0].actions) !== actions) throw new Error('Recentre hold also placed or pushed a marble')
          await page.locator('[data-marble=run]').click()
          await page.waitForFunction(() => window.__device.logic.units[0].running)
          rows.push({ tilt: await page.evaluate(() => ({ tiltX:window.__device.logic.units[0].tiltX, running:window.__device.logic.units[0].running })) })
        }
      } finally { await writeFile(join(out, `marble-screen-${width}x${height}.json`), JSON.stringify(rows,null,2)); await context.close() }
      return 'emulated sensors, both boards and fixed-clock contacts'
    })
  }
  await check('marblerun: motion permission requires a tap, denial keeps touch, reduced motion is static', async () => {
    const context = await browser.newContext({ viewport:{width:390,height:844}, hasTouch:true,isMobile:true,ignoreHTTPSErrors:true,reducedMotion:'reduce' })
    try {
      await context.addInitScript(() => {
        window.__permissionCalls = 0
        const deny = async () => { window.__permissionCalls++; return 'denied' }
        DeviceOrientationEvent.requestPermission = deny
        if (window.DeviceMotionEvent) DeviceMotionEvent.requestPermission = deny
      })
      const page = await context.newPage(); await page.goto(`${local.origin}/sim/marblerun/`)
      await page.waitForFunction(() => window.__device?.logic)
      if (await page.evaluate(() => window.__permissionCalls) !== 0) throw new Error('Permission requested without a tap')
      const before = await page.evaluate(() => window.__device.logic.renderState())
      await page.waitForTimeout(300)
      if (JSON.stringify(before) !== JSON.stringify(await page.evaluate(() => window.__device.logic.renderState()))) throw new Error('Reduced motion entrance moved')
      await page.locator('.marble-motion').click(); await page.getByText('Motion denied · drag').waitFor()
      await page.locator('[data-marble=run]').click()
      const actions = await page.evaluate(() => window.__device.logic.units[0].actions)
      await page.locator('#stage').tap({ position:{x:180,y:330} })
      await page.waitForFunction(before => window.__device.logic.units[0].actions > before,actions)
    } finally { await context.close() }
  })
}
