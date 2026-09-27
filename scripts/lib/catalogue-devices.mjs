/** Phone gestures for the second device collection; state is read only from the screen. */
export const deviceExercises = [
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
      ['y', 1.5],
      ['z', 0],
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
  { id: 'spotlights', face: 'face.wii', turn: true, field: 'pan', key: 'KeyC', button: 'colour' },
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

export async function exerciseDevice(e, { device, check, at, until, turn, clean }) {
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
      const b = await p.page.locator('#pad').boundingBox()
      await p.touches('touchStart', [[b.x + b.width / 2, b.y + b.height / 2]])
      try {
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
  await clean(e.id, s, p)
  await p.close()
  await s.close()
}
