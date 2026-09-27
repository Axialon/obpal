/**
 * How hard an idle, connected phone works: the Viewer from this checkout's build (local stand-in, signaling proxied
 * to production) and an emulated phone joined to it. After it settles, measure 10 s of doing nothing:
 *   - main-thread task and script time (CPU), style recalcs and layouts;
 *   - animation frames the page paints (each one recomposites the glass over whatever moves behind it);
 *   - how often the page's input loop runs (pump), and whether the motion sensors are on.
 * A phone left connected on a desk should do next to nothing. Needs Playwright's Chromium, or
 * OBPAL_E2E_CHROMIUM=<path to chrome.exe>.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'

const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 20000) {
  const end = Date.now() + timeout
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100) }
}

const local = await startLocal()
const closers = []
let dir = ''
try {
  const sb = await chromium.launch({ executablePath, args: RTC_ARGS })
  closers.push(sb)
  const screen = await (await sb.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })).newPage()
  await screen.goto(`${local.origin}/view/`)
  const invite = await until('invite', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''))
  dir = await mkdtemp(join(tmpdir(), 'obpal-perf-'))
  const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'], executablePath, args: RTC_ARGS })
  closers.push(ctx)
  // Count sensor events (and frames, if asked) from the start.
  if (process.env.OBPAL_PERF_FRAMES) await ctx.addInitScript(() => { window.__countFrames = true })
  await ctx.addInitScript(() => {
    window.__perf = { frames: 0, orient: 0, motion: 0 }
    // Counting frames with requestAnimationFrame makes frames of its own: only when asked (OBPAL_PERF_FRAMES=1).
    if (window.__countFrames) { const f = () => { window.__perf.frames++; requestAnimationFrame(f) }; requestAnimationFrame(f) }
    addEventListener('deviceorientation', () => window.__perf.orient++, true)
    addEventListener('devicemotion', () => window.__perf.motion++, true)
    // Who asks for layout: count getBoundingClientRect callers by stack (set OBPAL_PERF_STACKS=1 to print).
    window.__perf.rects = {}
    window.__perf.muts = {}
    addEventListener('DOMContentLoaded', () => new MutationObserver((list) => {
      for (const m of list) {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement
        const k = `${m.type}:${t?.id || t?.className || t?.tagName}${m.attributeName ? `@${m.attributeName}` : ''}`
        window.__perf.muts[k] = (window.__perf.muts[k] || 0) + 1
      }
    }).observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true }))
    const orig = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      const k = (new Error().stack || '').split(String.fromCharCode(10)).slice(2, 5).map((l) => l.trim().replace(/\(.*\/assets\//, '(').replace(/https?:[^)]*\//, '')).join(' < ')
      window.__perf.rects[k] = (window.__perf.rects[k] || 0) + 1
      return orig.call(this)
    }
  })
  // OBPAL_PERF_STILL=1: the same with every CSS animation off, to see what the animations cost.
  if (process.env.OBPAL_PERF_STILL) await ctx.addInitScript(() => addEventListener('DOMContentLoaded', () => document.head.insertAdjacentHTML('beforeend', '<style>*,*::before,*::after{animation:none!important}</style>')))
  const phone = ctx.pages()[0] ?? (await ctx.newPage())
  const cdp = await ctx.newCDPSession(phone)
  await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
  await cdp.send('Performance.enable')
  // OBPAL_PERF_URL=<url>: measure another page on the same emulated phone instead (a control, e.g. about:blank).
  if (process.env.OBPAL_PERF_URL) await phone.goto(process.env.OBPAL_PERF_URL)
  else {
    await phone.goto(invite)
    await phone.locator('.modes').waitFor({ timeout: 25000 })
  }
  await sleep(4000)
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  const a = await metrics()
  const pa = await phone.evaluate(() => ({ ...window.__perf }))
  const animating = await phone.evaluate(() => document.getAnimations().filter((x) => x.playState === 'running').map((x) => `${x.effect?.target?.className || x.effect?.target?.tagName}:${x.animationName ?? ''}`))
  await sleep(10000)
  const b = await metrics()
  const pb = await phone.evaluate(() => ({ ...window.__perf }))
  const per = (k) => ((b[k] - a[k]) * 100).toFixed(1)
  console.log('idle connected phone, 10 s:')
  console.log(`  CPU: tasks ${per('TaskDuration')}% · script ${per('ScriptDuration')}% · style recalcs ${b.RecalcStyleCount - a.RecalcStyleCount} · layouts ${b.LayoutCount - a.LayoutCount}`)
  console.log(`  ${process.env.OBPAL_PERF_FRAMES ? `frames: ${((pb.frames - pa.frames) / 10).toFixed(0)}/s · ` : ''}sensor events: ${((pb.orient - pa.orient + pb.motion - pa.motion) / 10).toFixed(0)}/s`)
  console.log(`  running animations: ${animating.length ? animating.join(', ') : 'none'}`)
  if (process.env.OBPAL_PERF_STACKS) {
    const rects = await phone.evaluate(() => window.__perf.rects)
    for (const [k, n] of Object.entries(rects).sort((x, y) => y[1] - x[1]).slice(0, 6)) console.log(`  ${n}× ${k}`)
    const muts = await phone.evaluate(() => window.__perf.muts)
    for (const [k, n] of Object.entries(muts).sort((x, y) => y[1] - x[1]).slice(0, 8)) console.log(`  mutation ${n}× ${k}`)
  }
} finally {
  await Promise.allSettled(closers.map((c) => c.close()))
  await local.close()
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
}
