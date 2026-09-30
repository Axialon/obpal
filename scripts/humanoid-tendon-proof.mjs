/** Deterministic curl and jab in the actual renderer; evidence stays in the caller's temporary folder. */
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const assert = (ok, message) => {
  if (!ok) throw new Error(message)
}
const label = (text, width, height = 40) =>
  Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#101314"/><text x="18" y="27" font-family="sans-serif" font-size="18" fill="#e5e9de">${text}</text></svg>`,
  )

export async function tendonProof(browser, origin, directory) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
  const samples = {}
  try {
    const page = await context.newPage()
    await page.goto(`${origin}/sim/humanoid/?test=humanoid`)
    await page.waitForFunction(() => window.__humanoid?.actors.every((a) => a.rig.root.userData.lods === 2))
    if (await page.locator('.sim-window[data-panel="controls"]').isVisible())
      await page.locator('[data-panel-toggle="controls"]').click()
    const pair = page.locator('.obpal-chip .pill')
    if (await pair.count()) {
      await pair.focus()
      await pair.press('Escape')
      await pair.evaluate((button) => button.blur())
      await page.mouse.move(2, 2)
    }
    await page.evaluate(() => {
      window.proofStage = window.__humanoid.inspect()
      window.__humanoid.actors.forEach((a, i) => {
        a.control.stop()
        a.rig.root.visible = i === 0
      })
    })
    for (const kind of ['curl', 'jab']) {
      await page.evaluate((kind) => {
        const actor = window.__humanoid.actors[0],
          stage = window.proofStage
        actor.tendons.reset()
        actor.control.resetSource()
        actor.control.resume()
        actor.control.position.set(0, 0, 0)
        actor.control.q = Object.fromEntries(actor.rig.profile.joints.map((j) => [j.id, 0]))
        actor.rig.pose(actor.control.q)
        actor.rig.grip({ left: 0, right: 0 })
        stage.controls.minDistance = 0.1
        stage.camera.clearViewOffset()
        actor.rig.detail(
          stage.camera.position.set(
            kind === 'curl' ? -0.8 : 2.1,
            kind === 'curl' ? 0.86 : 1.5,
            kind === 'curl' ? -0.6 : -3.7,
          ),
        )
        stage.controls.target.set(kind === 'curl' ? -0.26 : 0, kind === 'curl' ? 0.77 : 0.96, 0)
        stage.camera.fov = 40
        stage.camera.updateProjectionMatrix()
        stage.controls.update()
        window.tendonProof = { frame: 0, samples: [], kind }
        if (kind === 'jab') actor.control.play('jab')
      }, kind)
      const tiles = [],
        times =
          kind === 'curl' ? [0, 0.04, 0.08, 0.16, 0.32, 0.7, 0.86, 1.5] : [0, 0.08, 0.16, 0.3, 0.45, 0.65, 0.85, 1.5]
      for (const [i, time] of times.entries()) {
        await page.evaluate((time) => {
          const actor = window.__humanoid.actors[0],
            proof = window.tendonProof
          while (proof.frame < Math.round(time * 120)) {
            proof.frame++
            const t = proof.frame / 120,
              curl = proof.kind === 'curl' ? +(t < 0.75) : +(t < 0.8)
            const q =
              proof.kind === 'curl'
                ? actor.control.q
                : actor.control.step(1 / 120, { x: 0, z: 0, yaw: 0, manual: false }, null)
            const pose = actor.tendons.step(q, { left: curl, right: curl }, 1 / 120)
            actor.rig.pose(pose)
            actor.rig.grip(actor.tendons.grip)
            const hand = actor.rig.root.getObjectByName('left_arm_fingers')
            if (Math.abs(hand.rotation.x - actor.tendons.grip.left * actor.rig.profile.compliance.fingers[0]) > 1e-6)
              throw new Error('Authored finger pivot bypassed the tendon ratio')
            proof.samples.push({
              t,
              target: proof.kind === 'curl' ? curl : q['left.arm.elbow'],
              actual: proof.kind === 'curl' ? actor.tendons.grip.left : pose['left.arm.elbow'],
            })
          }
        }, time)
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const raw = await page.locator('#stage').screenshot({ path: join(directory, `tendon-${kind}-${i}.png`) })
        tiles.push({
          input: await sharp(raw).resize(720, 450).png().toBuffer(),
          left: (i % 4) * 720,
          top: Math.floor(i / 4) * 490 + 40,
        })
        tiles.push({
          input: label(`${kind} / ${time.toFixed(2)} s`, 720),
          left: (i % 4) * 720,
          top: Math.floor(i / 4) * 490,
        })
      }
      samples[kind] = await page.evaluate(() => window.tendonProof.samples)
      assert(
        samples[kind].some((s) => Math.abs(s.target - s.actual) > 0.1),
        `${kind} did not demonstrate elastic lag`,
      )
      assert(Math.abs(samples[kind].at(-1).actual - samples[kind].at(-1).target) < 0.01, `${kind} did not settle`)
      await sharp({ create: { width: 2880, height: 980, channels: 4, background: '#101314' } })
        .composite(tiles)
        .png()
        .toFile(join(directory, `tendon-${kind}-strip.png`))
    }
    await writeFile(
      join(directory, 'tendon-motion.json'),
      JSON.stringify({ cadenceHz: 120, simulatedSeconds: 1.5, samples }, null, 2),
    )
    const lines = Object.entries(samples)
      .map(([kind, data], row) => {
        const points = (key) => data.map((s) => `${60 + s.t * 700},${row * 260 + 225 - s[key] * 85}`).join(' ')
        return `<text x="60" y="${row * 260 + 35}" fill="#e5e9de">${kind}: target (grey), tendon pose (lime)</text><polyline points="${points('target')}" fill="none" stroke="#83918e" stroke-width="2"/><polyline points="${points('actual')}" fill="none" stroke="#c6ff34" stroke-width="3"/>`
      })
      .join('')
    await writeFile(
      join(directory, 'tendon-motion.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="520"><rect width="100%" height="100%" fill="#101314"/><g font-family="sans-serif" font-size="22">${lines}</g></svg>`,
    )
    return 'Coupled authored fingers; curl and jab yield, lag and settle. 120 Hz deterministic strips and raw target/pose samples.'
  } finally {
    await context.close()
  }
}
