/** The live three.js scene, at both viewport sizes. All evidence goes to the caller's temporary folder. */
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'

export async function modelProof(browser, origin, directory) {
  const views = [
    ['front', 0],
    ['three-quarter', 35],
    ['side', 90],
    ['back', 180],
  ]
  for (const [size, width, height] of [
    ['desktop', 1440, 900],
    ['phone', 412, 915],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: size === 'phone',
      hasTouch: size === 'phone',
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
    })
    try {
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${origin}/sim/humanoid/?test=humanoid`)
      await page.waitForFunction(() => window.__humanoid?.actors.every((a) => a.rig.root.userData.lods === 2))
      await page.evaluate(() => document.fonts.ready)
      // Keep the real page chrome, with its shared panel collapsed.
      const toggle = page.locator('[data-panel-toggle="controls"]')
      if (await page.locator('.sim-window[data-panel="controls"]').isVisible()) await toggle.click()
      // Dismiss the real pairing popover through its shared toggle.
      const pair = page.locator('.obpal-chip .pill')
      if (await pair.count()) {
        await pair.focus()
        await pair.press('Escape')
        await pair.evaluate((button) => button.blur())
        await page.mouse.move(2, 2)
      }
      await page.evaluate(() => {
        window.proofStage = window.__humanoid.inspect()
        for (const a of window.__humanoid.actors) a.control.stop()
      })
      for (let robot = 0; robot < 2; robot++) {
        for (const [view, degrees] of views) {
          await page.evaluate(
            ({ robot, degrees }) => {
              const h = window.__humanoid,
                stage = window.proofStage
              h.actors.forEach((a, i) => {
                a.rig.root.visible = i === robot
                a.rig.pose({})
                a.rig.grip({ left: 0, right: 0 })
              })
              const angle = (degrees * Math.PI) / 180
              stage.controls.target.set(0, 0.88, 0)
              stage.camera.clearViewOffset()
              stage.camera.position.set(4.0 * Math.sin(angle), 1.18, -4.0 * Math.cos(angle))
              stage.camera.fov = 40
              stage.camera.updateProjectionMatrix()
              stage.controls.update()
              for (const actor of h.actors) actor.rig.detail(stage.camera.position)
            },
            { robot, degrees },
          )
          await page.waitForTimeout(180)
          await page.screenshot({ path: join(directory, `${size}-${robot ? 'morrow' : 'keel'}-${view}.png`) })
        }
      }
      await page.evaluate(() => {
        const stage = window.proofStage
        window.__humanoid.actors.forEach((a, i) => {
          a.rig.root.visible = true
          const V = a.rig.root.position.constructor
          a.rig.pose(
            { 'left.arm.elbow': 0.35, 'right.arm.elbow': 0.2 },
            new V(i ? 0.64 : -0.61, 0, 0),
            i ? 0.18 : -0.18,
          )
        })
        stage.controls.target.set(0, 0.77, 0)
        stage.camera.position.set(2.7, 2.4, -4.8)
        if (innerWidth < innerHeight)
          stage.camera.position.sub(stage.controls.target).multiplyScalar(1.6).add(stage.controls.target)
        stage.controls.update()
        for (const actor of window.__humanoid.actors) actor.rig.detail(stage.camera.position)
      })
      await page.waitForTimeout(180)
      await page.screenshot({ path: join(directory, `${size}-pair-arena.png`) })
      if (size === 'desktop' && process.env.OBPAL_HUMANOID_MODEL_PROOF_ONLY !== '1') {
        const sweeps = []
        for (let robot = 0; robot < 2; robot++) {
          const joints = await page.evaluate(
            (robot) => window.__humanoid.actors[robot].rig.profile.joints.filter((j) => j.limits[0] !== j.limits[1]),
            robot,
          )
          for (const joint of joints) {
            const tiles = []
            for (let step = 0; step <= 16; step++) {
              const angle = joint.limits[0] + ((joint.limits[1] - joint.limits[0]) * step) / 16
              await page.evaluate(
                ({ robot, joint, angle }) => {
                  const stage = window.proofStage,
                    h = window.__humanoid
                  h.actors.forEach((actor, i) => {
                    actor.rig.root.visible = i === robot
                  })
                  // Park the other limbs apart so an isolated joint can be inspected
                  // without the opposite hand or foot covering its moving sleeve.
                  const q = {
                    'left.arm.roll': 0.3,
                    'right.arm.roll': 0.3,
                    'left.leg.roll': 0.25,
                    'right.leg.roll': 0.25,
                  }
                  q[joint.id] = angle
                  h.actors[robot].rig.pose(q)
                  stage.controls.target.set(0, 0.95, 0)
                  stage.camera.position.set(2.3, 1.6, -4)
                  stage.controls.update()
                  for (const actor of h.actors) actor.rig.detail(stage.camera.position)
                },
                { robot, joint, angle },
              )
              await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
              )
              if (step === 0 || step === 8 || step === 16) {
                const raw = await page.locator('#stage').screenshot()
                tiles.push({
                  input: await sharp(raw).resize(720, 450).png().toBuffer(),
                  left: tiles.length * 720,
                  top: 44,
                })
              }
              sweeps.push({ robot: robot ? 'morrow' : 'keel', joint: joint.id, radians: angle })
            }
            const label = `${robot ? 'Morrow' : 'Keel'} · ${joint.id} · minimum / midpoint / maximum`
            const title = Buffer.from(
              `<svg width="2160" height="44"><rect width="2160" height="44" fill="#111"/><text x="22" y="29" font-family="sans-serif" font-size="21" fill="#e8ecdf">${label}</text></svg>`,
            )
            await sharp({ create: { width: 2160, height: 494, channels: 4, background: '#111' } })
              .composite([...tiles, { input: title, left: 0, top: 0 }])
              .png()
              .toFile(join(directory, `sweep-${robot ? 'morrow' : 'keel'}-${joint.id}.png`))
          }
        }
        await writeFile(
          join(directory, 'joint-sweeps.json'),
          JSON.stringify(
            {
              poses: sweeps,
              limits: 'Independent named axes, other limbs parked; not a simultaneous self-collision solver.',
            },
            null,
            2,
          ),
        )
      }
      if (errors.length) throw new Error(errors.join('; '))
    } finally {
      await context.close()
    }
  }
  return '18 live scene views; desktop 1440×900 and phone 412×915'
}
