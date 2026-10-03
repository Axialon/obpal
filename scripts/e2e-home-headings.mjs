/** Section text contacts, using the home suite's guarded browser and service. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rawRun } from './lib/distill.mjs'

export async function runHomeHeadings(browser, local, check) {
  await check('viewport field heading contacts: lazy text, visible rims and hit light', async () => {
    const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'heading-contacts')
    await mkdir(out, { recursive: true })
    const raw = rawRun(out), frames = [], results = []
    try {
      for (const [width, height] of [[1920, 1080], [390, 844]]) {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
        await context.addInitScript(() => {
          const request = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window), pending = new Map()
          let next = 0
          window.__headingFrames = { frozen: false }
          window.requestAnimationFrame = callback => {
            const id = ++next
            const run = time => {
              if (window.__headingFrames.frozen) pending.set(id, request(run))
              else { pending.delete(id); callback(time) }
            }
            pending.set(id, request(run))
            return id
          }
          window.cancelAnimationFrame = id => { const scheduled = pending.get(id); if (scheduled !== undefined) cancel(scheduled); pending.delete(id) }
        })
        const page = await context.newPage()
        try {
          await page.goto(`${local.origin}/?debug=colliders`)
          await page.mouse.move(3, 300)
          await page.waitForFunction(() => window.__home?.contacts().rects.length > 20)
          const initial = await page.evaluate(() => {
            const headings = [...document.querySelectorAll('main h2, main .eyebrow')].filter(el => !el.closest('.pair, .scene, .build-card'))
            return {
              headings: headings.map((el, index) => ({ index, text: el.textContent.trim() })),
              distant: window.__home.contacts().rects.filter(b => b.rect.text && b.rect.y > innerHeight + 200).length,
            }
          })
          if (initial.distant) throw new Error(`${width}: distant heading colliders were eagerly built`)
          for (const heading of initial.headings) {
            await page.evaluate(index => {
              window.__home.clearSeeds()
              const el = [...document.querySelectorAll('main h2, main .eyebrow')].filter(el => !el.closest('.pair, .scene, .build-card'))[index]
              scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 230))
            }, heading.index)
            await page.waitForTimeout(150)
            const contact = await page.evaluate(index => {
              window.__headingFrames.frozen = true
              const el = [...document.querySelectorAll('main h2, main .eyebrow')].filter(el => !el.closest('.pair, .scene, .build-card'))[index]
              const range = document.createRange(), lines = []
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
              while (walker.nextNode()) {
                const text = walker.currentNode, start = text.data.search(/\S/)
                if (start < 0) continue
                range.setStart(text, start); range.setEnd(text, text.data.trimEnd().length)
                lines.push(...[...range.getClientRects()].filter(r => r.width && r.height))
              }
              const area = window.__home.outline('me')?.area
              const line = lines.find(r => r.top > (area?.top ?? 0) + 1 && r.bottom < Math.min(innerHeight, area?.bottom ?? innerHeight) - 1)
              if (!line) return { error: 'no heading line inside the visible play area' }
              const target = window.__home.contacts().rects.find(b => b.rect.text && Math.abs(b.rect.y - scrollY - line.top) < 2 && b.rect.x <= line.left + 1 && b.rect.x + b.rect.w >= line.right - 1)
              if (!target) return { error: 'visible heading has no text collider' }
              window.__headingLit = false
              window.__headingObserver?.disconnect()
              window.__headingObserver = new MutationObserver(() => { if (el.classList.contains('field-hit')) window.__headingLit = true })
              window.__headingObserver.observe(el, { attributes: true, attributeFilter: ['class'] })
              window.__home.seed('heading', line.left + line.width / 2, line.top + 1)
              window.__home.showSeeds()
              return { line: { x: line.left, y: line.top, w: line.width, h: line.height }, target }
            }, heading.index)
            if (contact.error) throw new Error(`${width} ${heading.text}: ${contact.error}`)
            await page.waitForFunction(() => window.__headingLit, null, { polling: 20, timeout: 5000 })
            const samples = []
            for (let sample = 0; sample < 8; sample++) {
              samples.push(await page.evaluate(() => {
                const outline = window.__home.outline('proof-heading')
                if (!outline) throw new Error('missing heading marble outline')
                const x = (outline.left + outline.right) / 2, y = (outline.top + outline.bottom) / 2
                const rx = (outline.right - outline.left) / 2, ry = (outline.bottom - outline.top) / 2
                const overlap = window.__home.contacts().rects.filter(b => b.rect.text).some(({ rect: r }) => {
                  const dx = Math.max(r.x - x, 0, x - r.x - r.w)
                  const dy = Math.max(r.y - scrollY - y, 0, y - r.y + scrollY - r.h)
                  return (dx / rx) ** 2 + (dy / ry) ** 2 < .98
                })
                return { t: window.__home.sim().t, outline, overlap, light: window.__headingLit }
              }))
              if (sample === 0) {
                const path = `${width}-${heading.index}.png`
                await page.screenshot({ path: join(raw, path) })
                frames.push({ path, timeMs: 0, failed: samples.at(-1).overlap })
                await page.evaluate(() => { window.__headingFrames.frozen = false })
              }
              await page.waitForTimeout(40)
            }
            results.push({ viewport: [width, height], heading: heading.text, ...contact, samples })
            await writeFile(join(out, 'measurements.json'), JSON.stringify({ results }, null, 2))
            if (samples.some(s => s.overlap)) throw new Error(`${width} ${heading.text}: rendered marble overlaps text`)
          }
        } catch (error) {
          const path = `${width}-failure.png`
          await page.screenshot({ path: join(raw, path) })
          frames.push({ path, failed: true })
          results.push({ viewport: [width, height], failure: String(error) })
          throw error
        } finally { await context.close() }
      }
    } finally {
      await writeFile(join(out, 'measurements.json'), JSON.stringify({ captureTiming: 'The test RAF gate freezes each seeded contact through its screenshot, then resumes the motion samples.', results }, null, 2))
      await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, fps: 1, frames }, null, 2))
    }
    return `${results.length} heading contacts: no text overlap, each lights on contact`
  })
}
