/** Phone tray and touch impulses through the guarded local sims runner, never a hardware connection. */
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { BUTTON_SIZES } from './lib/sim-buttons.mjs'
import { inkError, measureButtonInk } from './lib/button-ink.mjs'

export async function runMarbleControls(browser, local, check, out) {
  await check('marblerun phone: centred tray, repeated pushes and touch drag retain momentum', async () => {
    const rows = [], sizes = new Set()
    const screenContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
    try {
      await phoneContext.addInitScript(() => {
        for (const key of ['gyro', 'models', 'more', 'point', 'lock', 'track', 'level', 'hold-part']) sessionStorage.setItem(`obpal.hint.${key}`, '1')
      })
      const screen = await screenContext.newPage(), phone = await phoneContext.newPage()
      await screen.goto(`${local.origin}/sim/marblerun/`)
      await screen.waitForFunction(() => !!window.__obpal?.pairingUrl)
      await phone.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
      await phone.waitForFunction(() => document.body.classList.contains('live'))
      if (!(await phone.locator('.modes').isVisible())) {
        await phone.locator('.gp:not([hidden]) [data-act=controllers]').click()
        await phone.locator('.ctl-card[data-c="face.trackpad"]').click()
      }
      await phone.locator('#tray [data-id="push"]').waitFor()
      // Real controller packets must activate motion without another Motion-chip tap.
      const orientation = async gamma => {
        await phone.evaluate(gamma => {
          window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 60, gamma }))
          window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 0 } }))
        }, gamma)
      }
      await orientation(0)
      await phone.waitForFunction(() => document.getElementById('gyro')?.getAttribute('aria-pressed') === 'true')
      await orientation(35)
      await screen.waitForFunction(() => window.__device.logic.units.some(u => Math.abs(u.tiltX) > .12 || Math.abs(u.tiltZ) > .12))
      // A holder tilting the second board must bring that board's companions into view without a drag first.
      await screen.evaluate(() => window.__sim.claims.take('marblerun2', window.__obpal.participants[0].id))
      await screen.waitForFunction(() => Math.abs(window.__device.stage.controls.target.x - 3.8) < .001)
      await phone.locator('#center').click()
      await screen.waitForFunction(() => window.__device.logic.units.every(u => Math.hypot(u.tiltX,u.tiltZ) < .001))
      await phone.locator('#gyro').click()
      await screen.evaluate(() => window.__sim.claims.take('marblerun1', window.__obpal.participants[0].id))
      for (const [width, height] of BUTTON_SIZES) {
        const size = `${width}x${height}`, state = 'tray'
        await phone.setViewportSize({ width, height }); await phone.evaluate(() => document.fonts.ready)
        await phone.locator('#toast.show').waitFor({ state: 'hidden' })
        for (const id of ['push', 'place', 'turn', 'piece', 'remove', 'run']) {
          const button = phone.locator(`#tray [data-id="${id}"]`)
          await button.scrollIntoViewIfNeeded(); await phone.waitForTimeout(100)
          const name = await button.getAttribute('aria-label')
          const measured = (await phone.evaluate(measureButtonInk)).filter(row => row.classes.split(' ').includes('tray-btn'))
          rows.push(...measured.map(row => ({ size, state: `${state}-${id}`, ...row })))
          if (!measured.some(row => row.name === name)) throw new Error(`Marble ${id} control was not measured`)
          if (measured.some(row => inkError(row) > .5 || row.iconOnly && !row.name)) throw new Error('Marble phone controls are off centre or unnamed')
        }
        sizes.add(size)
        await screen.evaluate(() => window.__device.logic.units.forEach((_, n) => window.__device.logic.home(n)))
        const actions = await screen.evaluate(() => window.__device.logic.units.reduce((sum, u) => sum + u.actions, 0))
        const push = phone.locator('#tray [data-id="push"]')
        for (let n = 0; n < 20; n++) {
          await push.click()
          await screen.waitForFunction(before => window.__device.logic.units.reduce((sum, u) => sum + u.actions, 0) > before, actions + n)
        }
        const before = await screen.evaluate(() => window.__device.logic.units.flatMap(u => [u, ...u.marbles].map(m => ({ x: m.x, z: m.z }))))
        await phone.waitForTimeout(250)
        const coast = await screen.evaluate(() => window.__device.logic.units.flatMap(u => [u, ...u.marbles].map(m => ({ x: m.x, z: m.z, speed: Math.hypot(m.vx, m.vz) }))))
        rows.push({ size, state: 'release', before, coast })
        if (!coast.some((u, n) => u.speed > .001 && Math.hypot(u.x - before[n].x, u.z - before[n].z) > .001)) throw new Error(`Released phone pushes did not coast: ${JSON.stringify({ before, coast })}`)
        await phone.locator('#tray [data-id="run"]').click()
        await screen.waitForFunction(() => window.__device.logic.units.some(u => u.running))
        const box = await phone.locator('#pad').boundingBox()
        if (!box) throw new Error('Phone trackpad is missing')
        const cdp = await phone.context().newCDPSession(phone), x = box.x + box.width * .35, y = box.y + box.height * .5
        const count = await screen.evaluate(() => window.__device.logic.units.reduce((sum, u) => sum + u.actions, 0))
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
        for (let n = 1; n <= 10; n++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + box.width * .3 * n / 10, y, id: 1 }] })
          await phone.waitForTimeout(20)
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach()
        await screen.waitForFunction(before => window.__device.logic.units.reduce((sum, u) => sum + u.actions, 0) > before, count)
        const bodies = await screen.evaluate(() => window.__device.logic.units.flatMap(u => [u, ...u.marbles].map(m => ({ x: m.x, z: m.z, vx: m.vx, vz: m.vz }))))
        if (bodies.some(m => !Object.values(m).every(Number.isFinite) || Math.abs(m.x) > 1.45 || Math.abs(m.z) > 1.45)) throw new Error('Phone impulse escaped the board')
        rows.push({ size, state: 'motion', bodies, coast })
        await phone.screenshot({ path: join(out, `marble-phone-${size}.png`) })
        if (size === '390x844') await screen.screenshot({ path: join(out, 'marble-host-1440x900.png') })
      }
    } catch (error) {
      await writeFile(join(out, 'marble-controls.json'), JSON.stringify(rows, null, 2))
      await Promise.allSettled(phoneContext.pages().map((page, n) => page.screenshot({ path: join(out, `marble-phone-failure-${n}.png`) })))
      throw error
    } finally { await phoneContext.close(); await screenContext.close() }
    await writeFile(join(out, 'marble-controls.json'), JSON.stringify(rows, null, 2))
    return `20 real tray pushes and touch drag at ${sizes.size} emulated sizes; release coasts`
  })
  await check('marblerun iOS controller: permission is requested by Start, denial leaves working touch controls', async () => {
    const screenContext = await browser.newContext({ ignoreHTTPSErrors: true })
    const phoneContext = await browser.newContext({ viewport:{width:390,height:844}, hasTouch:true,isMobile:true,ignoreHTTPSErrors:true, userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' })
    try {
      await phoneContext.addInitScript(() => {
        window.__motionRequests = 0
        const deny = async () => { window.__motionRequests++; return 'denied' }
        DeviceOrientationEvent.requestPermission = deny
        DeviceMotionEvent.requestPermission = deny
        for (const key of ['gyro','models','more','point','lock','track','level']) sessionStorage.setItem(`obpal.hint.${key}`,'1')
      })
      const screen = await screenContext.newPage(), phone = await phoneContext.newPage()
      await screen.goto(`${local.origin}/sim/marblerun/`)
      await screen.waitForFunction(() => !!window.__obpal?.pairingUrl)
      await phone.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
      await phone.locator('#start').waitFor()
      if (await phone.evaluate(() => window.__motionRequests) !== 0) throw new Error('iOS motion was requested before a tap')
      await phone.locator('#start').click()
      await phone.locator('#tray [data-id=push]').waitFor()
      if (await phone.evaluate(() => window.__motionRequests) !== 2) throw new Error('Both sensor permissions were not requested in Start')
      const count = await screen.evaluate(() => window.__device.logic.units.reduce((sum,u) => sum+u.actions,0))
      await phone.locator('#tray [data-id=push]').click()
      await screen.waitForFunction(before => window.__device.logic.units.reduce((sum,u) => sum+u.actions,0) > before,count)
      if (await phone.locator('#gyro').getAttribute('aria-pressed') !== 'false') throw new Error('Denied motion is shown active')
      await phone.screenshot({path:join(out,'marble-ios-denied-touch.png')})
    } finally { await phoneContext.close(); await screenContext.close() }
  })
}
