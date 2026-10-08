/** Phone gestures for the second device collection; state is read only from the screen. */
export const deviceExercises = [
  { id: 'octopus', face: 'face.gamepad', drag: ['.gp-stick[data-stick="0"]', 0, -55], field: 'z', key: 'Space', button: 'actions', home: [['x', 0], ['z', 0.9], ['v', 0]] },
  { id: 'jib', face: 'face.gamepad', drag: ['.gp-stick[data-stick="0"]', 45, -25], field: 'swing', key: 'Space', button: 'actions', home: [['swing', 0], ['boom', 0.15], ['pan', 0]] },
  { id: 'slider', face: 'face.trackpad', drag: ['#pad', 55, 0], field: 'x', key: 'Space', button: 'actions', home: [['x', 0], ['pan', 0], ['tilt', 0]] },
  { id: 'trebuchet', face: 'face.trackpad', drag: ['#pad', 45, -25], field: 'weight', key: 'Space', button: 'actions', home: [['weight', 25], ['angle', 45], ['z', -.4 * Math.sin(.65) + 2.12 * Math.cos(.65)]] },
  { id: 'pendulum', face: 'face.trackpad', drag: ['#pad', 50, -15], field: 'length', key: 'Space', button: 'actions', home: [['length', 1.2], ['angle', 0], ['omega', 0]] },
  { id: 'telescope', face: 'face.wii', turn: true, field: 'pan', key: 'Space', button: 'actions', home: [['pan', 0], ['elevation', 0.4], ['zoom', 1]] },
  { id: 'planetary', face: 'face.gamepad', drag: ['.gp-stick[data-stick="0"]', 15, -50], field: 'z', key: 'Space', button: 'actions', home: [['x', -2], ['z', 3], ['v', 0]] },
  { id: 'marblerun', face: 'face.trackpad', drag: ['#pad', 45, -20], field: 'cursorX', key: 'Space', button: 'actions', home: [['cursorX', 2], ['cursorZ', 2]] },
  { id: 'football', face: 'face.gamepad', drag: ['.gp-stick[data-stick="0"]', 45, -40], field: 'x', key: 'Space', button: 'actions', home: [['x', 0], ['angle', 0]] },
  { id: 'pinball', face: 'face.gamepad', hold: '.gp-trig[data-trig="1"]', field: 'balls', key: 'KeyN', button: 'actions', home: [['x', 0.59], ['z', 1.05], ['plunger', 0]] },
  { id: 'airhockey', face: 'face.trackpad', drag: ['#pad', 65, -25], field: 'x', key: 'Space', button: 'actions', home: [['x', 0], ['z', 1.05]] },
  { id: 'smarthome', face: 'face.trackpad', drag: ['#pad', 0, -55], field: 'target', key: 'KeyM', button: 'actions', home: [['target', 0.7]] },
  { id: 'submarine', face: 'face.gamepad', drag: ['.gp-stick[data-stick="0"]', 15, -55], field: 'z', key: 'Space', button: 'actions', home: [['x', -1.8], ['y', 4], ['z', 4], ['v', 0]] },
  { id: 'helicopter', face: 'face.gamepad', hold: '.gp-trig[data-trig="1"]', field: 'y', key: 'KeyT', button: 'actions', home: [['x', -2], ['y', 0.22], ['z', 4], ['vy', 0]] },
  { id: 'kart', face: 'face.wheel', hold: '.gp-trig[data-trig="1"]', field: 'x', key: 'Space', button: 'actions', home: [['x', -0.7], ['z', 7], ['v', 0]] },
  { id: 'sorting', face: 'face.wii', turn: true, field: 'aim', key: 'Space', button: 'actions', home: [['x', 0], ['push', 0]] },
  { id: 'dog', face: 'face.gamepad', drag: ['.gp-stick[data-stick="0"]', 25, -55], field: 'z', key: 'Space', button: 'actions', home: [['x', -2.2], ['z', 2.2], ['v', 0]] },
  {
    id: 'slotcars',
    face: 'face.wheel',
    hold: '.gp-trig[data-trig="1"]',
    field: 's',
    key: 'Space',
    button: 'actions',
    home: [
      ['s', 3.8],
      ['v', 0],
    ],
  },
  {
    id: 'plane',
    face: 'face.gamepad',
    hold: '.gp-trig[data-trig="1"]',
    field: 'z',
    key: 'Space',
    button: 'powered',
    home: [
      ['x', 0],
      ['z', 8],
      ['v', 0],
    ],
  },
  {
    id: 'gimbal',
    face: 'face.trackpad',
    matching: true,
    field: 'pan',
    key: 'KeyR',
    button: 'recording',
    home: [
      ['pan', 0],
      ['pitch', 0],
    ],
  },
  {
    id: 'painter',
    face: 'face.hand',
    hand: true,
    field: 'points',
    key: 'KeyC',
    button: 'colour',
    home: [
      ['x', 0],
      ['y', 1.9],
      ['z', -2.91],
    ],
  },
  {
    id: 'forklift',
    face: 'face.gamepad',
    drag: ['.gp-stick[data-stick="1"]', 20, -55],
    field: 'lift',
    key: 'Space',
    button: 'actions',
    home: [
      ['x', 0],
      ['z', 2],
      ['lift', 0.12],
    ],
  },
  {
    id: 'excavator',
    face: 'face.gamepad',
    drag: ['.gp-stick[data-stick="0"]', 45, 25],
    field: 'swing',
    key: 'Space',
    button: 'curl',
    home: [
      ['swing', 0],
      ['boom', 0.65],
      ['stick', -1.35],
    ],
  },
  {
    id: 'tank',
    face: 'face.gamepad',
    aim: true,
    turn: true,
    field: 'turret',
    key: 'Space',
    button: 'shots',
    home: [
      ['x', -2],
      ['z', 2],
      ['turret', 0],
    ],
  },
  { id: 'spotlights', face: 'face.wii', turn: true, field: 'pan', key: 'KeyC', button: 'colour', home: [['x', 0], ['z', 1.5]] },
  {
    id: 'vacuum',
    face: 'face.wii',
    hold: '#wii-b',
    field: 'z',
    key: 'KeyC',
    button: 'clean',
    home: [
      ['x', -4],
      ['z', 3],
    ],
  },
]

export async function exerciseDevice(e, { device, phone, heldBy, check, at, until, turn, clean }) {
  const { s, p, face } = await device(e.id, { landscape: e.face === 'face.gamepad' })
  const state = () => at(s, () => window.__device.logic.units[0])
  await check(`${e.id}: its suggested controller moves the device`, async () => {
    if (face !== e.face) throw new Error(`opened on ${face}`)
    const before = await state()
    if (face === 'face.wii') await p.tab('point')
    if (e.matching) {
      await p.tab('rotate')
      await p.page.locator('[data-style="match"]').click()
      const gyro = p.page.locator('#gyro')
      if ((await gyro.getAttribute('aria-pressed')) !== 'true') await gyro.click()
      await turn(p, 10, 35, 15)
    }
    if (e.hand) {
      await p.tab('track')
      await p.page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
      // Deliver a sensor sample after the controller's listeners are mounted.
      await turn(p, 9, 10, 2)
      // Wait for sensor tracking and a stable, reachable pad before placing the held finger.
      await p.page.locator('#track-start').waitFor({ state: 'hidden' })
      await p.page.locator('#pad').click({ trial: true })
      const b = await p.page.locator('#pad').boundingBox()
      await p.touches('touchStart', [[b.x + b.width / 2, b.y + b.height / 2]])
      try {
        await until('the hand pad is held', () => p.page.locator('#pad').evaluate(pad => pad.classList.contains('active')))
        // The first held pose anchors the stroke. Let it reach the screen before swinging the phone.
        await until('the held hand pose', async () => (await state()).q.slice(0, 3).some((v) => Math.abs(v) > 0.01)).catch(
          async (error) => {
            throw new Error(
              `${error.message}: ${JSON.stringify(await state())}; inputs ${JSON.stringify(await at(s, () => window.__device.seen))}; pad active ${await p.page.locator('#pad').evaluate((pad) => pad.classList.contains('active'))}`,
            )
          },
        )
        await turn(p, 10, 40, 15)
        await until('the hand paints', async () => (await state())[e.field] > before[e.field])
      } finally {
        await p.touches('touchEnd', [])
      }
    }
    if (e.aim) {
      await p.page.evaluate(() =>
        dispatchEvent(
          new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }),
        ),
      )
      const chip = p.page.locator('.gp-chip[data-chip="motion.aim"]')
      if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click()
      if ((await chip.getAttribute('aria-pressed')) !== 'true') throw new Error('Aim did not enable')
      // CDP orientation alone has no angular velocity. Aim consumes the phone's motion event.
      await p.page.evaluate(async () => {
        for (let n = 0; n < 40; n++) {
          dispatchEvent(
            new DeviceMotionEvent('devicemotion', {
              rotationRate: { alpha: n < 35 ? 60 : 0, beta: 0, gamma: 0 },
              interval: 16,
            }),
          )
          await new Promise((r) => setTimeout(r, 16))
        }
      })
      // Calibrated Aim reads orientation; a real turn supplies orientation and angular velocity together.
      await turn(p, 10, 35)
    } else if (e.turn) await turn(p, 10, 35)
    if (e.hold) {
      await p.page.locator(e.hold).waitFor({ state: 'visible' })
      await p.hold(e.hold, 1100)
    }
    if (e.drag) await p.drag(e.drag[0], e.drag[1], e.drag[2], 1000)
    await until('the device moved', async () => Math.abs((await state())[e.field] - before[e.field]) > 0.01)
  })
  await check(`${e.id}: its keyboard binding works, and Home returns it`, async () => {
    const before = await state()
    await p.page.keyboard.press(e.key)
    await until('the bound action', async () => (await state())[e.button] !== before[e.button])
    // A newly recognised keyboard announces its bindings over the landscape pad's top row.
    const notice = p.page.locator('.bt-notice:not(.out) .bt-n-x')
    if (await notice.isVisible()) {
      await notice.click()
      await p.page.locator('.bt-notice').waitFor({ state: 'detached' })
    }
    if (['face.gamepad', 'face.wheel'].includes(face)) {
      if (process.env.OBPAL_SHOTS) await p.page.screenshot({ path: `${process.env.OBPAL_SHOTS}/${e.id}-phone.png` })
      await p.hold('.gp-guide', 250)
    } else await p.tapTray('Home')
    await until(
      'home',
      async () => {
        const u = await state()
        return (e.home ?? [['pan', 0]]).every(([key, value]) => Math.abs(u[key] - value) < 0.03)
      },
      20000,
    ).catch(async (error) => {
      throw new Error(
        `${error.message}: ${JSON.stringify(await state())}; inputs ${JSON.stringify(await at(s, () => window.__device.seen))}`,
      )
    })
  })
  if (e.id === 'tank') await check('tank: Set position and scene Take work inside the gamepad', async () => {
    await turn(p, 35, 45)
    await until('turret aims away', async () => Math.abs((await state()).turret) > 0.2)
    const shots = (await state()).shots
    await p.page.getByRole('button', { name: 'Set position', exact: true }).click()
    await until('turret re-centred', async () => Math.abs((await state()).turret) < 0.02)
    if ((await state()).shots !== shots) throw new Error('Set position fired a shot')
    await p.page.locator('.gp-scope').click()
    await turn(p, 45, 45 - 35 * 0.72)
    await until('second tank aimed', () => p.page.locator('.gp-scope small').textContent().then(t => t.includes('Tank 2')))
    await p.hold('.gp-f[data-k="a"]', 120)
    await until('second tank taken', () => heldBy(s, 'tank2'))
    await until('object scope', () => p.page.locator('.gp-scope').getAttribute('aria-pressed').then(v => v === 'false'))
  })
  if (e.id === 'pinball') await check('pinball: a quick phone tilt reversal nudges the cabinet', async () => {
    await p.tab('rotate')
    await p.page.locator('[data-style="game"]').click()
    const gyro = p.page.locator('#gyro')
    if (await gyro.getAttribute('aria-pressed') === 'true') await gyro.click()
    // Tilt is held flat like a tray; an upright Wii grip cannot roll 30 degrees about gravity.
    await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 0, gamma: 0 })
    await p.page.waitForTimeout(150)
    await gyro.click()
    const before = (await state()).actions
    // This phone joined in landscape: beta rocks across the screen's horizontal axis.
    for (const beta of [40, -40, 40, -40]) {
      await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta, gamma: 0 })
      await p.page.waitForTimeout(120)
    }
    await until('cabinet nudged from Tilt', async () => (await state()).actions > before).catch(async error => {
      throw new Error(`${error.message}: ${JSON.stringify(await at(s, () => window.__device.seen))}`)
    })
    await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 0, gamma: 0 })
  })
  if (['football', 'marblerun', 'planetary', 'telescope', 'pendulum', 'trebuchet', 'slider', 'jib'].includes(e.id)) {
    const { exerciseWave4b } = await import('./catalogue-wave4b.mjs')
    await exerciseWave4b(e.id, { s, p, state, phone, heldBy, check, at, until, clean })
  }
  await clean(e.id, s, p)
  await p.close()
  await s.close()
}
