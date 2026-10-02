/** Seeded contacts across every home section, using the guarded home suite's browser and service. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { rawRun } from './lib/distill.mjs'

export async function runHomeContacts(browser, local, check) {
  const only = process.env.OBPAL_E2E_HOME_ONLY || ''
  if (only && !only.includes('contact audit')) return
  await check('viewport field contact audit: seeded ledges, visibility and every section', async () => {
    const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'contacts')
    await mkdir(out, { recursive: true })
    const raw = rawRun(out), frames = [], results = []
    for (const [width, height] of [[1920, 1080], [1440, 900], [390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
      const page = await context.newPage()
      try {
        await page.goto(local.origin)
        await page.mouse.move(3, 300)
        await page.waitForFunction(() => window.__home?.contacts().rects.length > 20)
        await page.waitForTimeout(5000)
        const sections = await page.evaluate(() => [...document.querySelectorAll('main > section, .site-foot')].map(el => ({ name: el.className, y: el.getBoundingClientRect().y + scrollY, h: el.getBoundingClientRect().height })))
        for (const section of sections) {
          const windows = Math.max(1, Math.ceil(section.h / (height * .75)))
          for (let part = 0; part < windows; part++) {
            await page.evaluate(y => scrollTo(0, y), Math.max(0, section.y - 85 + part * height * .75))
            await page.waitForTimeout(300)
            for (const seed of [17, 29]) {
              const probes = await page.evaluate(seed => {
                window.__home.clearSeeds()
                const rects = window.__home.contacts().rects
                const nodes = [...document.querySelectorAll('main .cta .btn, main .pair, main .scene, main .build-card, main a, main button, main .qi, main .sec-head, .site-foot')]
                let n = seed
                const probes = nodes.flatMap((el, i) => {
                  const r = el.getBoundingClientRect(), css = getComputedStyle(el)
                  if (!r.width || !r.height || r.bottom < 85 || r.top > innerHeight - 30 || css.visibility === 'hidden') return []
                  n = (Math.imul(n, 1664525) + 1013904223) >>> 0
                  const x = Math.max(25, Math.min(innerWidth - 25, r.x + r.width * (.25 + (n / 4294967296) * .5)))
                  const y = Math.max(100, Math.min(innerHeight - 35, r.top + Math.min(4, r.height / 2)))
                  const id = `${seed}-${i}`
                  window.__home.seed(id, x, y)
                  const registered = rects.some(b => Math.abs(b.rect.x - r.x) < 1 && Math.abs(b.rect.y - scrollY - r.y) < 1 && Math.abs(b.rect.w - r.width) < 1)
                  return [{ id: `proof-${id}`, owner: `${el.tagName}.${el.className}`, registered, r: { x: r.x, y: r.y, w: r.width, h: r.height }, above: Number(css.zIndex) >= Number(getComputedStyle(document.querySelector('.hero-stage')).zIndex) }]
                })
                window.__home.showSeeds()
                return probes
              }, seed)
              const samples = [], slow = new Map(), stuck = new Set(), hidden = new Map(), interiors = new Map()
              const start = Date.now()
              for (let sample = 0; sample < 51; sample++) {
                const state = await page.evaluate(() => ({ t: window.__home.sim().t, tips: window.__home.tips(), contacts: window.__home.contacts(), scroll: scrollY }))
                for (const p of probes) {
                  const m = state.tips.find(m => m.id === p.id), body = state.contacts.marbles.find(m => m.id === p.id)
                  if (!m || !body) continue
                  for (const card of probes.filter(p => /(?:scene|build-card)/.test(p.owner))) {
                    if (m.x > card.r.x && m.x < card.r.x + card.r.w && m.y > card.r.y && m.y < card.r.y + card.r.h) interiors.set(card.owner, (interiors.get(card.owner) || 0) + 1)
                  }
                  const near = state.contacts.rects.some(b => m.x >= b.rect.x - 25 && m.x <= b.rect.x + b.rect.w + 25 && m.y >= b.rect.y - state.scroll - 25 && m.y <= b.rect.y + b.rect.h - state.scroll + 25)
                  if (body.speed < .05 && near && (m.h > .025 || m.held)) {
                    if (!slow.has(p.id)) slow.set(p.id, Date.now())
                    if (Date.now() - slow.get(p.id) > 1500) stuck.add(p.id)
                  } else slow.delete(p.id)
                  if (!p.registered && p.above && m.x >= p.r.x && m.x <= p.r.x + p.r.w && m.y >= p.r.y && m.y <= p.r.y + p.r.h) hidden.set(p.id, (hidden.get(p.id) || 0) + 1)
                }
                samples.push({ t: state.t, tips: state.tips, marbles: state.contacts.marbles, scroll: state.scroll })
                if (seed === 17 && part === 0 && [0, 8, 25, 50].includes(sample)) {
                  const dir = `${width}-${section.name.replaceAll(' ', '-')}`
                  await mkdir(join(raw, dir), { recursive: true })
                  const path = `${dir}/${sample}.png`
                  await page.screenshot({ path: join(raw, path) })
                  frames.push({ path, timeMs: sample * 100, failed: false })
                }
                await page.waitForTimeout(100)
              }
              results.push({ viewport: [width, height], section: section.name, part, seed, seconds: (Date.now() - start) / 1000, interiors: Object.fromEntries(interiors), probes: probes.map(p => ({ ...p, stuck: stuck.has(p.id), hiddenFrames: hidden.get(p.id) || 0 })), samples })
              await writeFile(join(out, 'measurements.json'), JSON.stringify({ seeds: [17, 29], results }, null, 2))
              console.log(`    ${width} ${section.name}/${part} seed ${seed}: stuck ${stuck.size}, hidden frames ${[...hidden.values()].reduce((a, b) => a + b, 0)}`)
            }
          }
        }
        await page.evaluate(() => { window.__home.clearSeeds(); scrollTo(0, 0) })
        await page.waitForTimeout(300)
        const controls = await page.evaluate(() => {
          const rect = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null }
          return { toggle: rect('[data-field-toggle]'), volume: rect('[data-sound]'), tab: rect('.quick-tab'), label: document.querySelector('[data-field-toggle]').getAttribute('aria-label') }
        })
        await writeFile(join(out, `controls-${width}.json`), JSON.stringify(controls, null, 2))
        const dir = `${width}-controls`
        await mkdir(join(raw, dir), { recursive: true })
        for (const state of ['on', 'off']) {
          if (state === 'off') await page.locator('[data-field-toggle]').click()
          const path = `${dir}/${state}.png`
          await page.screenshot({ path: join(raw, path) })
          frames.push({ path, timeMs: 0, failed: false })
        }
        if (!process.env.OBPAL_CONTACT_BASELINE) {
          const { toggle: a, volume: b, tab: c } = controls
          if (!controls.label || Math.abs(a.x - b.x) > 1 || a.y + a.h >= b.y || a.w !== 44 || a.h !== 44) throw new Error('field toggle is not an aligned icon stack')
          if (c && a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y) throw new Error('field toggle overlaps the phone-side tab')
        }
      } finally { await context.close() }
    }
    const summary = results.map(r => ({ viewport: r.viewport, section: r.section, part: r.part, seed: r.seed, probes: r.probes.length, stuck: r.probes.filter(p => p.stuck).length, hidden: r.probes.reduce((n, p) => n + p.hiddenFrames, 0), interiors: Object.values(r.interiors).reduce((a, b) => a + b, 0) }))
    await writeFile(join(out, 'measurements.json'), JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), seeds: [17, 29], threshold: { speedEmPerSecond: .05, contactSeconds: 1.5 }, summary, results }, null, 2))
    await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, fps: 10, frames }, null, 2))
    if (!process.env.OBPAL_CONTACT_BASELINE && summary.some(r => r.stuck || r.hidden || r.interiors)) throw new Error(`stuck ${summary.reduce((n, r) => n + r.stuck, 0)}, hidden ${summary.reduce((n, r) => n + r.hidden, 0)}, interiors ${summary.reduce((n, r) => n + r.interiors, 0)}; see contacts/measurements.json`)
    return `${summary.length} seeded section windows measured`
  })
}
