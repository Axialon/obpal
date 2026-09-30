/** Soft roster, forms, swaps and face signatures in the actual scene. Evidence stays in the caller's temporary folder. */
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

export async function softProof(browser, origin, directory) {
  const results = []
  for (const [size, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: size === 'phone', hasTouch: size === 'phone', deviceScaleFactor: 1, ignoreHTTPSErrors: true })
    try {
      const page = await context.newPage()
      const requests = []
      const errors = []
      page.on('request', request => { if (/\/(cairn|rill|hush)-.*\.glb/.test(request.url())) requests.push(new URL(request.url()).pathname) })
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => { if (message.type() === 'error' && /shader|WebGL|THREE/i.test(message.text())) errors.push(message.text()) })
      await page.goto(`${origin}/sim/humanoid/?test=humanoid`)
      await page.waitForFunction(() => window.__humanoid?.actors.every(a => a.rig.root.userData.lods === 2))
      if ((await page.locator('#robot-choice option').allTextContents()).join(',') !== 'Keel,Morrow') throw new Error('Default roster exposes preview robots')
      await page.evaluate(() => window.__humanoid.changeRobot(0, 'cairn', 0))
      if (!await page.evaluate(() => window.__humanoid.actors[0].rig.profile.id === 'keel-v1')) throw new Error('Default seat can select a hidden preview robot')
      await page.screenshot({ path: join(directory, `${size}-default-roster.png`) })
      await page.goto(`${origin}/sim/humanoid/?test=humanoid&preview=soft`)
      await page.waitForFunction(() => window.__humanoid?.actors.every(a => a.rig.root.userData.lods === 2))
      await page.goto(`${origin}/sim/humanoid/?test=humanoid`)
      await page.waitForFunction(() => window.__humanoid?.actors.every(a => a.rig.root.userData.lods === 2))
      if (await page.locator('meta[name="robots"]').getAttribute('content') !== 'noindex, follow') throw new Error('Preview is indexable')
      const pair = page.locator('.obpal-chip .pill')
      if (await pair.count()) { await pair.focus(); await pair.press('Escape'); await pair.evaluate(button => button.blur()); await page.mouse.move(2, 2) }
      if (requests.length) throw new Error('Unselected soft robots were downloaded')
      const panel = page.locator('.sim-window[data-panel="controls"]')
      const toggle = page.locator('[data-panel-toggle="controls"]')
      if (!await panel.isVisible()) { await toggle.focus(); await toggle.click() }
      if ((await page.locator('#robot-choice option').allTextContents()).join(',') !== 'Keel,Morrow,Cairn,Rill,Hush') throw new Error('Roster mismatch')
      for (const id of ['cairn', 'rill', 'hush']) {
        await page.locator('[data-seat="0"]').click()
        await page.getByRole('combobox', { name: 'Robot for this seat', exact: true }).click()
        await page.getByRole('option', { name: id[0].toUpperCase()+id.slice(1), exact: true }).click()
        await page.waitForFunction(id => window.__humanoid.actors[0].rig.profile.model === `${id}-i` && window.__humanoid.actors[0].rig.root.userData.lods === 2, id)
        await page.locator('[data-form="1"]').click()
        await page.waitForFunction(id => window.__humanoid.actors[0].rig.profile.model === `${id}-ii` && window.__humanoid.actors[0].rig.root.userData.lods === 2, id)
        const pressed = await page.locator('[data-form="1"]').getAttribute('aria-pressed')
        if (pressed !== 'true') throw new Error('Form choice is not exposed accessibly')
        const copy = await panel.innerText()
        if (/female|male|gender/i.test(copy)) throw new Error('Gender label exposed in controls')
        await page.screenshot({ path: join(directory, `${size}-${id}-form-controls.png`) })
        await page.evaluate(id => { window.__humanoid.changeRobot(0, id, 0); window.__humanoid.changeRobot(1, id, 1) }, id)
        await page.waitForFunction(id => window.__humanoid.actors.every((a, i) => a.rig.profile.model === `${id}-${i ? 'ii' : 'i'}` && a.rig.root.userData.lods === 2), id)
        if (await panel.isVisible()) await panel.getByRole('button', { name: 'Close Controls', exact: true }).click()
        await page.locator('[data-panel-toggle="controls"]').evaluate(button => button.blur())
        await page.mouse.move(width - 3, 3)
        await page.waitForTimeout(300)
        await page.evaluate(() => {
          const h = window.__humanoid, stage = h.inspect()
          const V = stage.camera.position.constructor
          h.actors.forEach((a, i) => {
            a.rig.pose({ 'left.arm.roll': .09, 'right.arm.roll': .09 }, new V(i ? .47 : -.47, 0, 0), i ? .12 : -.12)
            a.rig.grip({ left: 0, right: 0 })
            a.rig.face(0, false, true)
          })
          stage.controls.target.set(0, .88, 0)
          stage.camera.position.set(2.2, 1.8, innerWidth < innerHeight ? -6 : -4.0)
          stage.camera.clearViewOffset()
          stage.controls.update()
          h.actors.forEach(a => a.rig.detail(stage.camera.position))
          window.softStage = stage
        })
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(directory, `${size}-${id}-forms-arena.png`) })
        const proof = await page.evaluate(() => {
          const stage = window.softStage, a = window.__humanoid.actors[0]
          const frozen = () => ({ blink: a.rig.faceLight.uniforms.blink.value, x: a.rig.faceLight.uniforms.glance.value.x, glow: a.rig.faceLight.uniforms.glow.value })
          a.rig.face(5.7, true, false)
          const blink = frozen()
          a.rig.face(123, true, true)
          const reduced = frozen()
          a.rig.face(456, true, true)
          const reducedAgain = frozen()
          a.rig.face(0, false, true)
          const covers = new Map()
          a.rig.root.traverse(mesh => { if (mesh.isMesh && mesh.material.name.endsWith('Cover')) covers.set(mesh.material.name, { physical: !!mesh.material.isMeshPhysicalMaterial, roughness: mesh.material.roughness, clearcoat: mesh.material.clearcoat ?? 0 }) })
          return { blink, reduced, reducedAgain, covers: [...covers.values()], memory: stage.renderer.info.memory, gfx: stage.view.gfx(), models: window.__humanoid.actors.map(a => a.rig.profile.model) }
        })
        if (proof.blink.blink >= 1 || JSON.stringify(proof.reduced) !== JSON.stringify(proof.reducedAgain) || proof.reduced.x !== 0) throw new Error('Face animation/reduced-motion mismatch')
        if (!proof.covers.length || proof.covers.some(cover => cover.physical !== (size === 'desktop') || cover.roughness < .8 || cover.clearcoat !== 0)) throw new Error('Wrong soft material tier')
        // Two rigs each retain hero and distant geometry, up to 51 batches per LOD,
        // plus the arena and stage. A third cached pair would exceed this bound.
        if (proof.gfx.calls > 120 || proof.gfx.triangles > 65000 || proof.memory.geometries > 230) throw new Error(`Soft scene budget or resource leak: ${JSON.stringify(proof)}`)
        results.push({ size, id, ...proof })
        for (const form of [0, 1]) {
          await page.evaluate(form => {
            const h = window.__humanoid, stage = window.softStage, V = stage.camera.position.constructor
            h.actors.forEach((a, i) => { a.rig.root.visible = i === form; a.rig.pose({ 'left.arm.roll': .09, 'right.arm.roll': .09 }, new V(), 0) })
            stage.controls.target.set(0, .88, 0)
            stage.camera.position.set(1.3, 1.3, -3.3)
            stage.camera.fov = 36
            stage.camera.updateProjectionMatrix()
            stage.controls.update()
            h.actors.forEach(a => a.rig.detail(stage.camera.position))
          }, form)
          await page.waitForTimeout(180)
          await page.screenshot({ path: join(directory, `${size}-${id}-${form ? 'ii' : 'i'}-arena.png`) })
        }
        if (!await panel.isVisible()) { await toggle.focus(); await toggle.click() }
      }
      await page.evaluate(() => { window.__humanoid.actors.forEach(a => a.control.stop()); window.__humanoid.changeRobot(0, 'cairn', 1) })
      await page.waitForFunction(() => window.__humanoid.actors[0].rig.root.userData.lods === 2)
      if (!await page.evaluate(() => window.__humanoid.actors[0].control.stopped)) throw new Error('Changing robot cleared Stop')
      if (errors.length) throw new Error(errors.join('\n'))
      if (requests.filter(url => url.endsWith('cairn-ii.glb')).length < 2) throw new Error('Unused soft geometry was retained instead of released')
    } finally { await context.close() }
  }
  const late = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
  try {
    const page = await late.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/models/cairn-i.glb', async route => { await new Promise(resolve => setTimeout(resolve, 1800)); await route.continue().catch(() => {}) })
    await page.goto(`${origin}/sim/humanoid/?test=humanoid&preview=soft`)
    await page.waitForFunction(() => window.__humanoid?.actors.every(a => a.rig.root.userData.lods === 2))
    await page.evaluate(() => { window.__humanoid.changeRobot(0, 'cairn', 0); window.__humanoid.changeRobot(0, 'rill', 1) })
    await page.waitForFunction(() => window.__humanoid.actors[0].rig.root.userData.lods === 2)
    await page.waitForTimeout(2200)
    if (!await page.evaluate(() => window.__humanoid.actors[0].rig.profile.model === 'rill-ii' && window.__humanoid.actors[0].rig.root.userData.prototype === 'blender') || errors.length) throw new Error(`Late old skin corrupted the replacement: ${errors.join('; ')}`)
    results.push({ lateSwap: 'A cancelled Cairn download cannot install into the replacement Rill rig' })
  } finally { await late.close() }
  await writeFile(join(directory, 'soft-roster-proof.json'), JSON.stringify(results, null, 2))
  return 'Default roster excludes previews; session-only opt-in, six forms, phone/desktop tiers, deterministic faces, Stop preservation and bounded resource swaps'
}
