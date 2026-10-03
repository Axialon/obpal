/** A live moving-card proof, under the home suite's browser lease and helper guard. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rawRun } from './lib/distill.mjs'

export async function runHomeMotion(browser, local, check) {
  await check('viewport field moving contact audit: solid cards sweep, wake and stay visible', async () => {
    const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'moving-contacts')
    await mkdir(out, { recursive: true })
    const raw = rawRun(out), frames = [], results = []
    for (const width of [1920, 1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true })
      const page = await context.newPage()
      try {
        await page.goto(local.origin)
        await page.mouse.move(3, 300)
        await page.waitForFunction(() => window.__home?.contacts().rects.length > 20)
        await page.waitForTimeout(5000)
        await page.evaluate(() => scrollTo(0, document.querySelector('.scene').getBoundingClientRect().y + scrollY - 200))
        await page.waitForTimeout(250)
        await page.evaluate(() => {
          const card = document.querySelector('.scene'), r = card.getBoundingClientRect()
          window.__home.seed('moving', r.x + r.width / 2, r.y - 35)
          window.__home.showSeeds()
          const style = new CSSStyleSheet()
          style.replaceSync('@keyframes contact-slide { from { transform: translateY(0); } to { transform: translateY(-100px); } } .home .scene.contact-motion { animation: contact-slide .9s linear alternate 4; }')
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, style]
          card.classList.add('contact-motion')
        })
        const samples = []
        for (let sample = 0; sample < 100; sample++) {
          samples.push(await page.evaluate(() => {
            const m = window.__home.tips().find(m => m.id === 'proof-moving')
            const cards = [...document.querySelectorAll('.scene, .build-card')].map(el => {
              const r = el.getBoundingClientRect()
              return { x: r.x, y: r.y, w: r.width, h: r.height, radius: Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, r.width / 2, r.height / 2) }
            })
            const body = window.__home.contacts().marbles.find(m => m.id === 'proof-moving')
            const interior = cards.some(r => {
              const x = Math.abs(m.x - r.x - r.w / 2) - r.w / 2 + r.radius, y = Math.abs(m.y - r.y - r.h / 2) - r.h / 2 + r.radius
              return Math.hypot(Math.max(x, 0), Math.max(y, 0)) + Math.min(Math.max(x, y), 0) < r.radius
            })
            return { wall: performance.now(), t: window.__home.sim().t, m, body, interior, cards, activity: window.__home.activity() }
          }))
          if ([0, 15, 45, 75, 99].includes(sample)) {
            await mkdir(join(raw, String(width)), { recursive: true })
            const path = `${width}/${sample}.png`
            await page.screenshot({ path: join(raw, path) })
            frames.push({ path, timeMs: sample * 40, failed: false })
          }
          await page.waitForTimeout(40)
        }
        const interiors = samples.filter(s => s.interior).length
        const travel = Math.max(...samples.map(s => s.m.y)) - Math.min(...samples.map(s => s.m.y))
        let slowAt = null, stuck = false
        for (const s of samples) {
          const near = s.cards.some(r => s.m.x >= r.x - 25 && s.m.x <= r.x + r.w + 25 && s.m.y >= r.y - 25 && s.m.y <= r.y + r.h + 25)
          if (s.body.speed < .05 && s.m.h > .025 && near) {
            slowAt ??= s.wall
            if (s.wall - slowAt > 1500) stuck = true
          } else slowAt = null
        }
        results.push({ width, movingColliders: 1, samples, interiors, travel, stuck: Number(stuck) })
        await writeFile(join(out, 'measurements.json'), JSON.stringify(results, null, 2))
        console.log(`    ${width}: moving card stuck ${Number(stuck)}, interior frames ${interiors}, marble travel ${travel.toFixed(1)}px`)
      } finally { await context.close() }
    }
    await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, fps: 25, frames }, null, 2))
    if (!process.env.OBPAL_CONTACT_BASELINE && results.some(r => r.stuck || r.interiors || r.travel < 30)) throw new Error('moving card stuck, tunneled or did not push the marble; see moving-contacts/measurements.json')
    return results.map(r => `${r.width}px: ${r.stuck} stuck, ${r.interiors} interior frames, ${r.travel.toFixed(1)}px travel`).join('; ')
  })
}
