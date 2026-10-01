/** Wave 4b tasks driven through the paired phone; the screen's simulation is read only. */
export async function exerciseWave4b(id, { s, p, state, phone, heldBy, check, at, until, clean }) {
  if (id === 'football') await check('football: four phones own separate stations and Home preserves the shared match', async () => {
    const guests = []
    try {
      for (let n = 1; n < 4; n++) { const guest = await phone(s.invite, { landscape: true }); guests.push(guest); await until(`football station ${n + 1}`, () => heldBy(s, `football${n + 1}`)) }
      const before = await at(s, () => window.__device.logic.rods.map(r => r.x))
      await guests[1].drag('.gp-stick[data-stick="0"]', before[3] > 0 ? -45 : 45, 0, 400)
      await until('third station moves', async () => Math.abs((await at(s, () => window.__device.logic.rods[3].x)) - before[3]) > 0.01)
      if (Math.abs((await state()).x - before[0]) > 0.001) throw new Error('teammate stole a held rod')
      await guests[1].hold('.gp-guide', 200)
      await until('third station homed', async () => Math.abs(await at(s, () => window.__device.logic.rods[3].x)) < 0.01)
      await clean('football four phones', ...guests)
    } finally { for (const guest of guests) await guest.close() }
  })
  if (id === 'marblerun') await check('marblerun: the phone fills the gap, starts a timed run and guides the marble', async () => {
    await p.tapTray('Place')
    await until('centre track placed', async () => (await state()).track[12] !== null)
    await p.tapTray('Run / build')
    await until('run started', async () => (await state()).running)
    for (let n = 0; n < 4 && (await state()).running; n++) await p.drag('#pad', 90, 0, 600)
    await until('marble and timer moved', async () => { const u = await state(); return u.x > -1 && u.time > 0 })
    const track = (await state()).track
    await p.tapTray('Home')
    // Home replays the physical feeder, then rests in the cup rather than at an exact scripted coordinate.
    await until('Home feeder replays', async () => { const u = await state(); return !u.running && u.time === 0 && u.start.phase === 'feeding' && u.start.elapsed < .48 })
    await until('Home feeder settles', async () => (await state()).start.phase === 'settled')
    const home = await state()
    if (home.running || home.finished || home.time !== 0 || home.cursorX !== 2 || home.cursorZ !== 2 || home.tiltX !== 0 || home.tiltZ !== 0) throw new Error('Home did not reset the run')
    if (JSON.stringify(home.track) !== JSON.stringify(track)) throw new Error('Home changed the built track')
    if ([home, ...home.marbles].some(m => Math.hypot(m.x + 1.16, m.z) >= .16 || m.vx !== 0 || m.vz !== 0)) throw new Error('Home marbles did not rest in the cup')
  })
  if (id === 'planetary') await check('planetary: a phone samples a reachable rock once and operates the mast', async () => {
    const before = (await state()).samples
    await p.page.keyboard.press('Space')
    await until('reachable sample collected', async () => (await state()).samples > before)
    await p.page.keyboard.press('Space')
    await p.page.waitForTimeout(200)
    if ((await state()).samples !== before + 1) throw new Error('sample collected twice')
    await p.page.keyboard.press('KeyM')
    await until('mast mode', async () => (await state()).mast)
    await p.drag('.gp-stick[data-stick="1"]', 45, -20, 400)
    await until('mast pans', async () => Math.abs((await state()).mastPan) > 0.02)
  })
  if (id === 'telescope') await check('telescope: Found it logs a centred object once and zoom changes the eyepiece', async () => {
    await p.page.keyboard.press('Space')
    await until('Moon logged', async () => (await state()).found.includes(0))
    const count = (await state()).found.length
    await p.page.keyboard.press('Space'); await p.tapTray('Zoom in')
    await until('eyepiece zoom', async () => (await state()).zoom > 1.1)
    if ((await state()).found.length !== count) throw new Error('duplicate object logged')
  })
  if (id === 'pendulum') await check('pendulum: a phone tilt flick pushes the bob and leaves a trace', async () => {
    await p.tab('rotate'); await p.page.locator('[data-style="game"]').click()
    const gyro = p.page.locator('#gyro')
    if (await gyro.getAttribute('aria-pressed') === 'true') await gyro.click()
    await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 0, gamma: 0 }); await p.page.waitForTimeout(150); await gyro.click()
    const before = (await state()).actions
    for (const gamma of [40, -40, 40, -40]) { await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 0, gamma }); await p.page.waitForTimeout(180) }
    await until('flick pushed pendulum', async () => (await state()).actions > before)
    if (!(await state()).trace.some(a => Math.abs(a) > 0.02)) throw new Error('trace stayed flat')
  })
  if (id === 'trebuchet') await check('trebuchet: the phone launches one shot and the arc reaches a landing', async () => {
    const before = (await state()).shots
    await p.tapTray('Launch')
    await until('shot released', async () => (await state()).phase === 'flight')
    await until('ballistic landing', async () => { const u = await state(); return u.phase === 'ready' && u.arc.length > 5 && u.last > 3 }, 15000)
    if ((await state()).shots !== before + 1) throw new Error('unexpected extra shot')
  })
  if (id === 'slider') await check('slider: two phone-authored keys play to their exact final pose', async () => {
    await p.tapTray('Clear keys'); await p.drag('#pad', -70, 0, 300); await p.tapTray('Set keyframe')
    await p.drag('#pad', 140, 0, 400); await p.tapTray('Set keyframe')
    await until('two keys stored', async () => (await state()).keys.length === 2)
    const before = await state(), end = before.keys[1]
    await p.tapTray('Play / stop')
    await until('playback starts', async () => (await state()).playing)
    await until('programmed shot finishes', async () => { const u = await state(); return !u.playing && u.takes > before.takes && Math.abs(u.x - end.x) < 0.001 }, 20000)
  })
  if (id === 'jib') await check('jib: the head moves independently while a phone records a take', async () => {
    const before = await state()
    if (!before.recording) await p.page.keyboard.press('Space')
    await p.drag('.gp-stick[data-stick="1"]', 40, -25, 600)
    await until('camera head pans', async () => Math.abs((await state()).pan) > 0.02)
    if (Math.abs((await state()).swing) > 0.01) throw new Error('head moved the boom')
    await p.page.keyboard.press('Space')
    await until('take ended', async () => { const u = await state(); return !u.recording && u.takes > before.takes })
  })
}
