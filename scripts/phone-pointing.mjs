/** Phone pointer gestures, observed at the RTC wire and the receiving Viewer. */
import { devices } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readButtonInk, inkError } from './lib/button-ink.mjs'
import { readControlOverlaps } from './lib/control-hitboxes.mjs'

export async function phonePointing({ browser, origin, check, shots, baseline = false }) {
  for (const device of ['Pixel 7', 'iPhone 13']) {
    const ctx = await browser.newContext({ ...devices[device], ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
    try {
      await ctx.addInitScript(() => {
        DeviceMotionEvent.requestPermission = DeviceOrientationEvent.requestPermission = async () => 'granted'
        setInterval(() => {
          window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 40, gamma: 0 }))
          window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 0 }, accelerationIncludingGravity: { x: 0, y: 6, z: 7 }, interval: 16 }))
        }, 16)
        for (const k of ['gyro', 'models', 'point', 'level', 'track', 'lock', 'hold-part', 'parts-phone', 'more']) sessionStorage.setItem(`obpal.hint.${k}`, '1')
        window.__wire = []
        window.__travel = null
        window.__pointer = []
        document.addEventListener('pointerdown', e => window.__pointer.push({ target: e.target.closest('[id]')?.id, x: e.clientX, y: e.clientY }), true)
        const send = RTCDataChannel.prototype.send
        RTCDataChannel.prototype.send = function (data) {
          if (typeof data === 'string') { try { window.__wire.push(JSON.parse(data)) } catch {} }
          // STATE's CSS-pixel accumulator (PROTOCOL §6), sampled before the reusable buffer changes.
          if (data instanceof ArrayBuffer && data.byteLength === 76) {
            const dv = new DataView(data)
            if (dv.getUint8(0) === 0x11) window.__travel = [dv.getInt32(48, true) / 16, dv.getInt32(52, true) / 16]
          }
          return send.call(this, data)
        }
      })
      const screen = await ctx.newPage(), phone = await ctx.newPage()
      await screen.goto(origin + '/view/')
      await screen.waitForFunction(() => !!window.__obpal?.pairingUrl)
      await screen.evaluate(() => { window.__received = []; window.__obpal.on('button', e => window.__received.push({ t: 'btn', id: e.id, ev: e.ev })) })
      await phone.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
      if (device === 'iPhone 13') await phone.locator('#gate #start').click()
      await phone.waitForFunction(() => document.body.classList.contains('live'))
      await phone.waitForTimeout(1000)
      const cdp = await ctx.newCDPSession(phone)
      const settingsDone = async () => { await phone.locator('#done').click(); await phone.locator('.sheet-wrap').waitFor({ state: 'detached' }) }
      const choose = async face => {
        await phone.locator('#ctl-more').evaluate(el => el.click())
        await phone.locator(`.ctl-card[data-c="face.${face}"]`).evaluate(el => el.click())
        await phone.waitForTimeout(750)
        await phone.locator(face === 'trackpad' ? '#pad' : `#${face}`).waitFor({ state: 'visible' })
        await screen.waitForFunction(face => window.__obpal.participants.some(p => p.controller === `face.${face}`), face)
      }
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id = 1]) => ({ x, y, id })) })
      const point = async (sel, fx = .5, fy = .5) => { const b = await phone.locator(sel).boundingBox(); return [b.x + b.width * fx, b.y + b.height * fy] }
      const tap = async p => { await touch('touchStart', [p]); await touch('touchEnd', []) }
      const log = []
      const scenario = async (name, expected, run) => check(`${device}: ${name}`, async () => {
        await phone.evaluate(() => { window.__wire = []; window.__pointer = [] })
        await screen.evaluate(() => { window.__received = [] })
        let error = ''
        try { await run() } catch (e) { error = e.message }
        await phone.waitForTimeout(200)
        const wire = await phone.evaluate(() => window.__wire.filter(m => m.t === 'btn'))
        const received = await screen.evaluate(() => window.__received)
        const pointers = await phone.evaluate(() => window.__pointer)
        log.push({ name, expected, wire, received, pointers, error })
        if (error) throw new Error(error)
        const seq = wire.map(m => `${m.id}:${m.ev}`)
        if (JSON.stringify(seq) !== JSON.stringify(expected)) throw new Error(`wire ${JSON.stringify(seq)}, wanted ${JSON.stringify(expected)}`)
        if (JSON.stringify(received.map(m => `${m.id}:${m.ev}`)) !== JSON.stringify(expected)) throw new Error(`receiver ${JSON.stringify(received)}`)
      })
      const pair = side => [`mouse-${side}:down`, `mouse-${side}:up`]
      await choose('mouse')
      for (const side of ['left', 'right']) {
        await scenario(`${side} tap`, pair(side), () => tapPoint(side))
        await scenario(`${side} quick double tap`, [...pair(side), ...pair(side)], async () => { await tapPoint(side); await tapPoint(side) })
      }
      async function tapPoint(side) { await tap(await point(`#mouse-${side}`)) }
      await scenario('press while moving and sliding off the half', pair('left'), async () => {
        const p = await point('#mouse-left')
        await touch('touchStart', [p])
        await phone.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 30, beta: 40, gamma: 20 })))
        await touch('touchMove', [[p[0] + 160, p[1] + 30]])
        await touch('touchEnd', [])
      })
      await scenario('seam below wheel belongs to left click', pair('left'), async () => tap(await point('.mouse-seam', .25, .85)))
      await scenario('near wheel on the left half', pair('left'), async () => tap(await point('#mouse-left', .98, .5)))
      await scenario('two fingers on a half keep holding until both lift', pair('left'), async () => {
        const p = await point('#mouse-left'); const q = [p[0] + 10, p[1] + 20, 2]
        await touch('touchStart', [p]); await touch('touchStart', [p, q]); await touch('touchEnd', [q])
        const early = await phone.evaluate(() => window.__wire.filter(m => m.t === 'btn').map(m => m.ev))
        await touch('touchEnd', [])
        if (early.includes('up')) throw new Error('released while the second finger was still held')
      })
      await scenario('press during recentre', pair('right'), async () => {
        await touch('touchStart', [await point('#mouse-right')]); await phone.locator('#mouse-home').evaluate(el => el.click()); await touch('touchEnd', [])
      })
      await scenario('cancel releases once', pair('left'), async () => { await touch('touchStart', [await point('#mouse-left')]); await touch('touchCancel', []) })
      await scenario('blur releases once', pair('left'), async () => {
        await touch('touchStart', [await point('#mouse-left')]); await phone.evaluate(() => window.dispatchEvent(new Event('blur')))
        const early = await phone.evaluate(() => window.__wire.filter(m => m.t === 'btn').map(m => m.ev))
        await touch('touchEnd', [])
        if (JSON.stringify(early) !== '["down","up"]') throw new Error(`before finger lifted: ${JSON.stringify(early)}`)
      })
      await scenario('hidden screen releases once', pair('right'), async () => {
        await touch('touchStart', [await point('#mouse-right')])
        await phone.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
        const early = await phone.evaluate(() => window.__wire.filter(m => m.t === 'btn').map(m => m.ev))
        await phone.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
        await touch('touchEnd', [])
        if (JSON.stringify(early) !== '["down","up"]') throw new Error(`before finger lifted: ${JSON.stringify(early)}`)
      })
      if (shots) {
        await mkdir(shots, { recursive: true })
        await phone.screenshot({ path: join(shots, `${device}-mouse.png`) })
        await writeFile(join(shots, `${device}-wire.json`), JSON.stringify(log, null, 2))
      }
      if (baseline && shots) for (const face of ['mouse', 'wii', 'trackpad']) {
        await choose(face)
        for (const width of [360, 390, 430]) {
          await phone.setViewportSize({ width, height: 844 }); await phone.waitForTimeout(250)
          await phone.screenshot({ path: join(shots, `${device}-${face}-default-${width}.png`) })
        }
      }
      if (!baseline) {
        await check(`${device}: the hit-area guard detects a tray covering the mouse face`, async () => {
          const saved = await phone.locator('#tray').getAttribute('style')
          try {
            await phone.evaluate(() => {
              const r = document.querySelector('.mouse-shell').getBoundingClientRect()
              document.querySelector('#tray').style.cssText = `position:fixed;left:${r.left}px;top:${r.bottom - 60}px;width:${r.width}px;height:60px;z-index:100`
            })
            const overlaps = await readControlOverlaps(phone)
            if (!overlaps.some(row => /mouse-(left|right)|mouse-seam/.test(row) && /tray-btn/.test(row))) throw new Error('the overlapping tray escaped the guard')
          } finally {
            await phone.locator('#tray').evaluate((el, style) => style === null ? el.removeAttribute('style') : el.setAttribute('style', style), saved)
          }
          return 'intentional collision rejected; layout restored'
        })
        await check(`${device}: pointing faces keep separate hit areas at 360–430 px, portrait and landscape, with either hand and one-hand on or off`, async () => {
          const bad = []
          let layouts = 0
          for (const face of ['mouse', 'wii', 'trackpad']) {
            await choose(face)
            for (const one of [false, true]) for (const left of [false, true]) {
              await phone.locator('#gear').evaluate(el => el.click())
              await phone.locator('#one-hand').setChecked(one)
              await phone.locator('#left').setChecked(left)
              await settingsDone()
              for (let width = 360; width <= 430; width += 10) for (const land of [false, true]) {
                const size = land ? { width: 664, height: width } : { width, height: 664 }
                await phone.setViewportSize(size)
                await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: devices[device].deviceScaleFactor, mobile: true, screenOrientation: { type: land ? 'landscapePrimary' : 'portraitPrimary', angle: land ? 90 : 0 } })
                await phone.waitForTimeout(100)
                layouts++
                for (const overlap of await readControlOverlaps(phone)) bad.push(`${face} ${size.width}×${size.height} one=${one} left=${left}: ${overlap}`)
                if (shots && width === 390) await phone.screenshot({ path: join(shots, `${device}-${face}-hit-${one ? 'one' : 'two'}-${left ? 'left' : 'right'}-${land ? 'landscape' : 'portrait'}.png`) })
              }
            }
            await phone.setViewportSize({ width: 390, height: 844 })
            await cdp.send('Emulation.clearDeviceMetricsOverride')
            await phone.locator('#gear').evaluate(el => el.click())
            await phone.locator('#one-hand').uncheck()
            await phone.locator('#left').uncheck()
            await settingsDone()
          }
          if (shots) await writeFile(join(shots, `${device}-hit-areas.json`), JSON.stringify({ layouts, bad }, null, 2))
          if (bad.length) throw new Error(bad.slice(0, 12).join('; '))
          return `${layouts} layouts, sampled every 8 px including touch extensions`
        })
        for (const face of ['mouse', 'wii', 'trackpad']) {
          await choose(face)
          await phone.locator('#gear').evaluate(el => el.click())
          if (await phone.locator('#one-hand').isChecked()) throw new Error(`${face} default changed`)
          await phone.locator('#one-hand').check()
          if (face === 'trackpad') await phone.locator('#thumb-scroll').check()
          await settingsDone()
          for (const left of [false, true]) {
            await phone.locator('#gear').evaluate(el => el.click())
            await phone.locator('#left').setChecked(left)
            await settingsDone()
            for (const { width, height } of [{ width: 360, height: 844 }, { width: 390, height: 844 }, { width: 430, height: 844 }, { width: 430, height: 932 }]) await check(`${device}: ${face} ${left ? 'left' : 'right'} hand at ${width}×${height}`, async () => {
              await phone.setViewportSize({ width, height }); await phone.waitForTimeout(250)
              const geometry = await phone.evaluate(face => {
                const ids = face === 'mouse' ? ['mouse-left', 'mouse-right', 'mouse-wheel', 'mouse-home', 'mouse-zoom-in', 'mouse-zoom-out'] : face === 'wii' ? ['wii-a', 'wii-b', 'wii-home', 'wii-minus', 'wii-plus', 'wii-right', 'wii-wheel'] : ['pad', 'pad-wheel']
                return { overflow: document.documentElement.scrollWidth - innerWidth, boxes: ids.map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { id, x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } }) }
              }, face)
              if (geometry.overflow > 0) throw new Error(`overflow ${geometry.overflow}`)
              for (const b of geometry.boxes) if (b.w < 48 || b.h < 48 || b.y < height * .4 - 1 || b.bottom > height || b.x < 0 || b.right > width) throw new Error(JSON.stringify(b))
              const rows = await readButtonInk(phone, { surfaces: true })
              const ids = new Set(geometry.boxes.map(b => b.id))
              const bad = rows.filter(r => !r.occluded && (ids.has(r.id) || r.classes.includes('thumb-settings')) && inkError(r) > .5)
              if (bad.length) throw new Error(`ink ${JSON.stringify(bad)}`)
              if (shots) {
                await phone.screenshot({ path: join(shots, `${device}-${face}-${left ? 'left' : 'right'}-${width}${height === 932 ? '-large' : ''}.png`) })
                if (width === 390) {
                  await phone.evaluate(left => {
                    const overlay = document.createElement('div'); overlay.id = 'reach-proof'
                    overlay.style.cssText = `position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:radial-gradient(ellipse at ${left ? '20%' : '80%'} 78%,#34d39955,transparent 45%),linear-gradient(to bottom,#f9731633 0 40%,transparent 40%);border-top:0`
                    const label = document.createElement('span'); label.textContent = 'Reach guide · bottom 60% · illustrative'
                    label.style.cssText = 'position:absolute;top:40%;left:0;right:0;border-top:1px dashed #34d399;background:#101010cc;color:white;font:12px sans-serif;padding:4px;text-align:center'
                    overlay.append(label); document.body.append(overlay)
                  }, left)
                  await phone.screenshot({ path: join(shots, `${device}-${face}-${left ? 'left' : 'right'}-reach.png`) })
                  await phone.evaluate(() => document.getElementById('reach-proof').remove())
                }
              }
              return 'targets ≥48px, bottom 60%, ink ≤0.5px'
            })
            if (face === 'mouse') {
              await scenario(`one hand ${left ? 'left' : 'right'}: primary double tap`, [...pair('left'), ...pair('left')], async () => { await tapPoint('left'); await tapPoint('left') })
              await scenario('one hand: secondary click', pair('right'), () => tapPoint('right'))
            } else if (face === 'wii') {
              await scenario('one hand Wii A tap', ['wii-a:down', 'wii-a:up', 'wii-a:tap'], async () => tap(await point('#wii-a')))
              await scenario('one hand Wii right click', pair('right'), async () => tap(await point('#wii-right')))
              await scenario('one hand Wii B cancel', ['wii-b:down', 'wii-b:up'], async () => { await touch('touchStart', [await point('#wii-b')]); await touch('touchCancel', []) })
            } else {
              const zone = () => point('#pad', .5, .4)
              await scenario('thumb pad quick double tap', [...pair('left'), ...pair('left')], async () => { await tap(await zone()); await tap(await zone()) })
              await scenario('thumb pad two-finger right tap', pair('right'), async () => {
                const p = await zone(); const q = [p[0] + 35, p[1], 2]
                await touch('touchStart', [p]); await touch('touchStart', [p, q]); await touch('touchEnd', [p]); await touch('touchEnd', [])
              })
              await scenario('thumb pad long press right click', pair('right'), async () => { await touch('touchStart', [await zone()]); await phone.waitForTimeout(560); await touch('touchEnd', []) })
              await scenario('thumb pad cancel never clicks', [], async () => { await touch('touchStart', [await zone()]); await touch('touchCancel', []) })
              await check(`${device}: thumb edge continues and lift stops travel without reposition jumps`, async () => {
                const p = await zone(), edge = await point('#pad', .5, .98)
                await touch('touchStart', [p]); await touch('touchMove', [edge]); await phone.waitForTimeout(70)
                const a = await phone.evaluate(() => window.__travel)
                await phone.waitForTimeout(180)
                const b = await phone.evaluate(() => window.__travel)
                if (b[1] - a[1] < 40) throw new Error(`edge travel ${JSON.stringify([a,b])}`)
                await touch('touchEnd', []); await phone.waitForTimeout(100)
                const lifted = await phone.evaluate(() => window.__travel)
                await touch('touchStart', [p]); await phone.waitForTimeout(100)
                const repositioned = await phone.evaluate(() => window.__travel)
                await touch('touchEnd', [])
                if (JSON.stringify(lifted) !== JSON.stringify(repositioned)) throw new Error(`reposition jumped ${JSON.stringify([lifted,repositioned])}`)
              })
            }
            if (face !== 'trackpad') await check(`${device}: ${face} one-hand wheel reaches the wire`, async () => {
              await phone.evaluate(() => { window.__wire = [] })
              const p = await point(face === 'mouse' ? '#mouse-wheel' : '#wii-wheel')
              await touch('touchStart', [p]); await touch('touchMove', [[p[0], p[1] + 24]]); await touch('touchEnd', [])
              await phone.waitForTimeout(100)
              const values = await phone.evaluate(() => window.__wire.filter(m => m.t === 'value' && m.id === 'mouse-wheel'))
              if (!values.some(m => m.v > 0)) throw new Error('no scroll value')
            })
          }
        }
        await check(`${device}: one-hand preferences and handedness survive reload`, async () => {
          await phone.reload()
          if (device === 'iPhone 13') await phone.locator('#gate #start').click()
          await phone.waitForFunction(() => document.body.classList.contains('live')); await phone.waitForTimeout(1000)
          for (const face of ['mouse', 'wii', 'trackpad']) {
            await choose(face)
            if (!await phone.locator('.surface.one-hand.left').count()) throw new Error(`${face} preference lost`)
          }
        })
        await check(`${device}: thumb motion also works in the two-handed layout`, async () => {
          await phone.locator('#gear').evaluate(el => el.click())
          await phone.locator('#one-hand').uncheck(); await phone.locator('#thumb-motion').check(); await settingsDone()
          if (await phone.locator('.surface.one-hand').count()) throw new Error('still in one-hand layout')
          for (const width of [360, 390, 430]) {
            await phone.setViewportSize({ width, height: 844 }); await phone.waitForTimeout(250)
            if (await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('two-handed overflow')
            if (shots) await phone.screenshot({ path: join(shots, `${device}-trackpad-two-hand-${width}.png`) })
          }
        })
        await scenario('two-handed thumb tap reaches the wire', pair('left'), async () => tap(await point('#pad', .5, .4)))
        if (shots) await writeFile(join(shots, `${device}-wire.json`), JSON.stringify(log, null, 2))
      }
    } finally { await ctx.close() }
  }
}
