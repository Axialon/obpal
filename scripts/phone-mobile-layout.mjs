/** Bounded mobile evidence inside the existing phone suite. Uses the actual Viewer and controller, no application hooks. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stableBox } from './lib/clip-browser.mjs'
import { paletteTapWitness } from './phone-evidence.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(name, read, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(100) }
  throw Error(`timed out: ${name}`)
}

/** Reveal a copy group using the Settings scroller, keeping its sticky header and footer clear. */
function scrollSettingsCopy({ ids, scroll }, env = globalThis) {
  const sheet = env.document.querySelector('.sheet-wrap:not(.out) .settings')
  const nodes = ids.map(id => env.document.getElementById(id))
  if (!sheet || !ids.length || nodes.some(node => !node || !sheet.contains(node))) throw Error('Settings copy group absent')
  const box = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height } }
  const panel = box(sheet), header = box(sheet.querySelector(':scope > .sheet-head')), footer = box(sheet.querySelector(':scope > .actions'))
  const top = Math.max(0, panel.top, header.bottom), bottom = Math.min(env.innerHeight, panel.bottom, footer.top)
  const before = nodes.map(box), first = Math.min(...before.map(r => r.top)), last = Math.max(...before.map(r => r.bottom))
  const from = sheet.scrollTop, hasRoom = bottom - top >= last - first
  if (scroll && hasRoom) sheet.scrollTop += (first + last - top - bottom) / 2
  const rows = nodes.map((node, i) => ({ id: ids[i], ...box(node) }))
  return { from, to: sheet.scrollTop, hasRoom, available: { top, bottom }, header, footer, rows, fullyVisible: hasRoom && rows.every(r => r.height > 0 && r.top >= top - 1 && r.bottom <= bottom + 1) }
}

/** Let every revealed row finish fitting, then centre the settled group once with ordinary scrolling. */
async function revealSettingsCopy(phone, ids) {
  const initial = await phone.evaluate(scrollSettingsCopy, { ids, scroll: true })
  let previous = null
  const settled = await until('Settings copy group geometry', async () => {
    const current = await phone.evaluate(scrollSettingsCopy, { ids, scroll: false })
    const boxes = [current.header, current.footer, ...current.rows]
    const stable = previous && boxes.length === previous.length && boxes.every((box, i) =>
      ['top', 'bottom', 'height'].every(key => Math.abs(box[key] - previous[i][key]) < 1))
    previous = boxes
    return stable ? current : null
  }, 1500)
  const recentered = await phone.evaluate(scrollSettingsCopy, { ids, scroll: true })
  return { initial, settled, recentered }
}

/** Read the genuine catalogue hint and all exposed chrome without changing its queue, clock or animation. */
function catalogueHintState() {
  const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
  const intersects = (a, b) => a.x + a.width > b.x && a.x < b.x + b.width && a.y + a.height > b.y && a.y < b.y + b.height
  const name = el => el?.id || el?.dataset.id || el?.dataset.tab || el?.tagName.toLowerCase() || null
  const hint = [...document.querySelectorAll('.hint.in:not(.away)')].find(el => el.querySelector('.hint-text')?.textContent === 'Browse the catalogue')
  const issues = [], controls = [], padTools = []
  const rect = hint ? box(hint) : null, style = hint ? getComputedStyle(hint) : null
  const positive = !!rect && rect.width > 0 && rect.height > 0 && Number(style.opacity) >= .99 && style.visibility !== 'hidden'
  if (!positive) issues.push('genuine visible catalogue hint absent')
  const envelope = rect ? { x: rect.x - 8, y: rect.y - 4, width: rect.width + 16, height: rect.height + 4 } : null
  if (rect && (rect.x < 0 || rect.y < 0 || rect.x + rect.width > innerWidth || rect.y + rect.height > innerHeight)) issues.push('catalogue hint outside viewport')
  const close = hint?.querySelector('.hint-x'), closeRect = close ? box(close) : null
  const pseudo = close ? getComputedStyle(close, '::before') : null
  const insets = pseudo ? Object.fromEntries(['left', 'top', 'right', 'bottom'].map(key => [key, Number.parseFloat(pseudo[key])])) : null
  const declared = !!pseudo && pseudo.position === 'absolute' && !['none', 'normal', ''].includes(pseudo.content) && Object.values(insets).every(Number.isFinite)
  const closeEffective = closeRect && declared ? { x: closeRect.x + insets.left, y: closeRect.y + insets.top, width: closeRect.width - insets.left - insets.right, height: closeRect.height - insets.top - insets.bottom } : null
  const closeOwned = !!closeRect && close.contains(document.elementFromPoint(closeRect.x + closeRect.width / 2, closeRect.y + closeRect.height / 2))
  const offsets = [[0, 0], [-21.75, 0], [21.75, 0], [0, -21.75], [0, 21.75], [-15.35, -15.35], [15.35, -15.35], [-15.35, 15.35], [15.35, 15.35], [-21.75, -21.75], [21.75, -21.75], [-21.75, 21.75], [21.75, 21.75]]
  const closeSamples = closeRect ? offsets.map(([dx, dy]) => {
    const x = closeRect.x + closeRect.width / 2 + dx, y = closeRect.y + closeRect.height / 2 + dy
    return { x, y, owned: close.contains(document.elementFromPoint(x, y)) }
  }) : []
  if (!closeOwned) issues.push('catalogue hint close target not owned')
  if (!closeEffective || closeEffective.width < 43.5 || closeEffective.height < 43.5) issues.push('catalogue hint close effective target below44px')
  if (closeSamples.length !== 13 || !closeSamples.every(sample => sample.owned)) issues.push('catalogue hint close44px extension ownership unproved')
  const anchor = document.querySelector('.tray-btn.select[data-id="model"]'), anchorRect = anchor ? box(anchor) : null
  if (!anchorRect || anchorRect.width <= 0 || anchorRect.height <= 0) issues.push('actual Models anchor absent')
  const side = ['top', 'bottom', 'left', 'right'].find(side => hint?.classList.contains(`hint-${side}`)) ?? null
  const vertical = side === 'left' || side === 'right'
  const detached = hint?.classList.contains('hint-detached') ?? false
  const arrowStyle = hint ? getComputedStyle(hint, '::before') : null, anchorStyle = anchor ? getComputedStyle(anchor) : null
  const arrowHidden = !!arrowStyle && (arrowStyle.display === 'none' || arrowStyle.content === 'none')
  const noteId = hint?.querySelector('.hint-text')?.id ?? '', describedBy = anchor?.getAttribute('aria-describedby') ?? ''
  const accent = anchorStyle?.getPropertyValue('--accent-rgb').trim().match(/[\d.]+/g) ?? []
  const accentColor = accent.length === 3 ? `rgb(${accent.join(', ')})` : null
  const shadow = anchorStyle?.boxShadow ?? ''
  const anchorRingPainted = !!accentColor && shadow.includes(accentColor) && shadow.includes('inset') && shadow.includes('0px 0px 0px 2px') && anchorStyle?.borderColor === accentColor
  const cue = { detached, arrowHidden, arrowPseudo: arrowStyle ? { display: arrowStyle.display, content: arrowStyle.content } : null,
    anchorEmphasized: anchor?.classList.contains('hint-anchor') ?? false, anchorRingPainted, accentColor, anchorBorderColor: anchorStyle?.borderColor ?? null, anchorBoxShadow: shadow,
    noteId, describedBy, described: !!noteId && describedBy.split(/\s+/).includes(noteId) }
  if (!detached || !cue.anchorEmphasized || !anchorRingPainted || !cue.described) issues.push('detached catalogue cue not associated with actual Models')
  if (detached && !arrowHidden) issues.push('detached catalogue hint still paints a decorative arrow')
  const arrow = Number.parseFloat(style?.getPropertyValue('--arrow') ?? ''), axis = rect ? (vertical ? rect.y : rect.x) + arrow : NaN
  const targetMin = anchorRect ? vertical ? anchorRect.y : anchorRect.x : NaN, targetMax = anchorRect ? targetMin + (vertical ? anchorRect.height : anchorRect.width) : NaN
  const caretMatches = Number.isFinite(axis) && Number.isFinite(targetMin) && axis >= targetMin && axis - (vertical ? 4 : 0) <= targetMax
  if (!vertical) issues.push('catalogue hint uses legacy placement in affected trackpad case')
  if (!detached && !caretMatches) issues.push('catalogue caret axis misses actual Models anchor')
  const pad = document.querySelector('#pad'), app = document.querySelector('#app')
  const candidates = [{ kind: 'pad', el: pad }, { kind: 'part', el: document.querySelector('#pad-part') }, { kind: 'gestures', el: document.querySelector('#gestures') },
    ...[...(pad?.querySelectorAll('button, [role="button"], [role="radio"], #nstrip, #ns-tag') ?? [])].map(el => ({ kind: 'blocker', el }))]
  const placementContext = { coordinateSpace: 'viewport', appTransform: app ? getComputedStyle(app).transform : null, candidates: candidates.filter(c => c.el).map(({ kind, el }) => {
    const s = getComputedStyle(el)
    return { kind, id: name(el), classes: typeof el.className === 'string' ? el.className : null, rect: box(el), hiddenByAttribute: !!el.closest('[hidden]'), hasOffsetParent: !!el.offsetParent, entering: el.classList?.contains('in') ?? false,
      display: s.display, visibility: s.visibility, opacity: s.opacity, pointerEvents: s.pointerEvents, position: s.position, transform: s.transform }
  }) }
  const nodes = new Set(document.querySelectorAll('#surface .bar button, #surface .modes button, #surface .tray button, #surface .dock button, #pad button, #pad [role="button"], #pad [role="radio"]'))
  for (const el of nodes) {
    const r = box(el), s = getComputedStyle(el)
    if (!r.width || !r.height || s.visibility === 'hidden' || el.closest('[hidden], [inert]')) continue
    let left = Math.max(0, r.x), top = Math.max(0, r.y), right = Math.min(innerWidth, r.x + r.width), bottom = Math.min(innerHeight, r.y + r.height)
    for (let parent = el.parentElement; parent && parent.id !== 'surface'; parent = parent.parentElement) {
      const p = box(parent), ps = getComputedStyle(parent)
      if (/(auto|scroll|hidden|clip)/.test(ps.overflowX)) { left = Math.max(left, p.x); right = Math.min(right, p.x + p.width) }
      if (/(auto|scroll|hidden|clip)/.test(ps.overflowY)) { top = Math.max(top, p.y); bottom = Math.min(bottom, p.y + p.height) }
    }
    if (right <= left || bottom <= top) continue
    const exposed = { x: left, y: top, width: right - left, height: bottom - top }
    const owner = document.elementFromPoint((left + right) / 2, (top + bottom) / 2), owned = el.contains(owner)
    const covered = !!envelope && intersects(envelope, exposed), closeOverlap = !!closeEffective && intersects(closeEffective, exposed)
    if (covered || closeOverlap) issues.push(`${name(el)}: catalogue hint covers exposed control`)
    if (hint?.contains(owner)) issues.push(`${name(el)}: catalogue hint owns control sample`)
    if (el.matches('.stop, [data-offered-stop], [data-id="model"]') && !owned) issues.push(`${name(el)}: critical control sample not owned`)
    const area = el.closest('.modes') ? 'mode' : el.closest('.tray') ? 'tray' : el.closest('.dock') ? 'dock' : el.closest('.bar') ? 'bar' : 'pad'
    controls.push({ id: name(el), area, rect: r, exposed, owned, owner: name(owner?.closest('button, [role="button"], [role="radio"]') ?? owner), covered, closeOverlap, existingChromeOcclusion: !owned && !hint?.contains(owner) })
  }
  for (const el of document.querySelectorAll('#gestures, #nstrip, #ns-tag')) {
    const r = box(el)
    const s = getComputedStyle(el)
    if (!r.width || !r.height || el.closest('[hidden]') || s.visibility === 'hidden' || Number(s.opacity) === 0) continue
    const owner = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    if (envelope && intersects(envelope, r)) issues.push(`${name(el)}: catalogue hint covers pad tool`)
    padTools.push({ id: name(el), rect: r, owner: name(owner), ownedByPad: !!owner?.closest('#pad') })
  }
  if (!controls.some(c => c.id === 'mobile-stop') || !controls.some(c => c.id === 'model')) issues.push('required Stop or Models exposure absent')
  for (const area of ['mode', 'tray', 'dock']) if (!controls.some(c => c.area === area)) issues.push(`${area} exposure absent`)
  if (!padTools.length) issues.push('pad tool exposure absent')
  return { at: performance.now(), viewport: { width: innerWidth, height: innerHeight }, issues, placementContext, hint: { positive, text: hint?.querySelector('.hint-text')?.textContent ?? null, rect, opacity: style?.opacity ?? null, side, arrow: style?.getPropertyValue('--arrow') ?? null, cue, caret: { painted: !arrowHidden, axis: vertical ? 'y' : 'x', coordinate: axis, targetMin, targetMax, matches: caretMatches }, envelope, pointerEvents: style?.pointerEvents ?? null, close: { rect: closeRect, effective: closeEffective, owned: closeOwned, samples: closeSamples, pseudo: pseudo ? { content: pseudo.content, position: pseudo.position, insets, width: pseudo.width, height: pseudo.height, borderRadius: pseudo.borderRadius, pointerEvents: pseudo.pointerEvents } : null } }, anchor: { id: anchor?.dataset.id ?? null, rect: anchorRect }, controls, padTools, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }
}

/** Prove the 44px target and transparent corners with real ownership, colour dispatch and neighbor isolation. */
async function paletteHitEvidence(phone, failed) {
  const buttons = phone.locator('.settings .accent-row .bb-accent'), count = await buttons.count(), records = []
  if (count < 2) throw Error('Settings palette absent from target precondition')
  const original = await phone.locator('.settings .accent-row .bb-accent[aria-checked="true"]').evaluateAll(els => els[0]?.dataset.accent ?? null)
  const failures = [], scrolls = []
  const reportFailure = async (stage, error) => {
    failures.push({ stage, error })
    try { await failed({ stage, reason: String(error.message), records, scrolls }) }
    catch (evidenceError) { failures.push({ stage: `evidence-${stage}`, error: evidenceError }) }
  }
  const reveal = async button => {
    const result = await button.evaluate(el => {
      const sheet = el.closest('.settings')
      if (!sheet) throw Error('Palette target has no Settings scroll container')
      const bounds = node => { const r = node?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, height: r.height } : null }
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      const panel = bounds(sheet), header = bounds(sheet.querySelector(':scope > .sheet-head')), footer = bounds(sheet.querySelector(':scope > .actions'))
      const top = Math.max(panel.top, header?.bottom ?? panel.top), bottom = Math.min(panel.bottom, footer?.top ?? panel.bottom)
      const from = sheet.scrollTop, target = bounds(el), hasRoom = bottom - top >= 44
      if (hasRoom) sheet.scrollTop += (target.top + target.bottom - top - bottom) / 2
      return { from, to: sheet.scrollTop, available: { top, bottom, height: bottom - top }, hasRoom, panel, header, footer, targetBefore: target, targetAfter: bounds(el) }
    })
    scrolls.push(result)
    if (!result.hasRoom) throw Error(`Palette has less than44px between sticky header and footer: ${result.available.height}px`)
    return result
  }
  const selected = async id => {
    const handle = await phone.waitForFunction(value => {
      const chosen = [...document.querySelectorAll('.settings .bb-accent[aria-checked="true"]')]
      if (chosen.length !== 1 || chosen[0].dataset.accent !== value) return null
      const expectedColor = getComputedStyle(chosen[0]).getPropertyValue('--sw').trim().toLowerCase()
      const actualColor = window.BlackboxesFamily.accentColor().toLowerCase()
      const appliedColor = getComputedStyle(document.documentElement).getPropertyValue('--bb-accent').trim().toLowerCase()
      return actualColor === expectedColor && appliedColor === expectedColor ? { id: value, expectedColor, actualColor, appliedColor } : null
    }, id)
    try { return await handle.jsonValue() } finally { await handle.dispose() }
  }
  try {
    await phone.bringToFront()
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i)
      const scroll = await reveal(button)
      const accent = await button.getAttribute('data-accent')
      if (!/^[a-z][a-z0-9-]{0,23}$/.test(accent ?? '')) throw Error('Palette target has no bounded component id')
      const settleStarted = Date.now()
      await stableBox({ page: phone }, `.settings .accent-row .bb-accent[data-accent="${accent}"]`, 1500)
      const settleMs = Date.now() - settleStarted
      const record = await button.evaluate(async el => {
        const rect = node => { const r = node.getBoundingClientRect(); return Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, Math.round(r[k] * 100) / 100])) }
        // Describe geometry and component ownership only: no text, URLs, seal or connection identifiers.
        const describe = node => {
          if (!node) return null
          const s = getComputedStyle(node)
          return { tag: node.tagName.toLowerCase(), classes: [...node.classList].slice(0, 6).map(c => c.slice(0, 48)), role: node.getAttribute('role'), rect: rect(node), position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents, overflowX: s.overflowX, overflowY: s.overflowY, transform: s.transform, opacity: s.opacity }
        }
        const ancestors = []; let node = el.parentElement
        while (node && ancestors.length < 6) { ancestors.push(node); node = node.parentElement }
        const started = performance.now(), geometry = []; let previous = '', consecutive = 0
        for (let frame = 0; frame < 4; frame++) {
          await new Promise(requestAnimationFrame)
          const sheet = el.closest('.settings')
          const state = { target: describe(el), ancestors: ancestors.map(node => ({ ...describe(node), scrollTop: node.scrollTop, scrollLeft: node.scrollLeft })), sticky: { header: describe(sheet?.querySelector(':scope > .sheet-head')), footer: describe(sheet?.querySelector(':scope > .actions')) } }
          const signature = JSON.stringify(state)
          consecutive = signature === previous ? consecutive + 1 : 0; previous = signature
          geometry.push({ at: Math.round(performance.now()), ...state })
        }
        const stable = consecutive >= 3
        const animations = [el, ...ancestors].map(node => ({ component: { tag: node.tagName.toLowerCase(), classes: [...node.classList].slice(0, 6).map(c => c.slice(0, 48)) }, animations: node.getAnimations().slice(0, 4).map(a => ({ kind: a.constructor.name, name: (a.animationName ?? a.transitionProperty ?? '').slice(0, 48), playState: a.playState, pending: a.pending, currentTime: Number.isFinite(Number(a.currentTime)) ? Number(a.currentTime) : null })) }))
        const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2
        const offsets = [[0, 0], [-21.75, 0], [21.75, 0], [0, -21.75], [0, 21.75], [-15.35, -15.35], [15.35, -15.35], [-15.35, 15.35], [15.35, 15.35], [-21.75, -21.75], [21.75, -21.75], [-21.75, 21.75], [21.75, 21.75]]
        const samples = offsets.map(([dx, dy]) => {
          const px = x + dx, py = y + dy, hit = document.elementFromPoint(px, py)
          return { x: px, y: py, owned: hit?.closest('button') === el, owner: describe(hit), buttonOwner: describe(hit?.closest('button')), stack: document.elementsFromPoint(px, py).slice(0, 4).map(describe) }
        })
        const before = getComputedStyle(el, '::before'), after = getComputedStyle(el, '::after'), style = getComputedStyle(el)
        return { id: el.dataset.accent, x, y, width: r.width, height: r.height, requiredDiameter: 44, sampleInset: 0.25, paint: { buttonRadius: style.borderRadius, discRadius: before.borderRadius, extensionRadius: after.borderRadius, extensionFill: after.backgroundColor }, viewport: { width: innerWidth, height: innerHeight, visibility: document.visibilityState }, geometry: { method: 'existing stableBox, then four consecutive animation-frame snapshots', stable, consecutive, frames: geometry.length, elapsedMs: Math.round(performance.now() - started), first: geometry[0], last: geometry.slice(-3), animations }, samples, valid: stable && samples.every(s => s.owned) }
      })
      record.scroll = scroll
      record.geometry.helperElapsedMs = settleMs
      records.push(record)
      if (!record.geometry.stable) throw Error(`palette ${record.id}: geometry still moving after the bounded settle check`)
      if (!record.valid) throw Error(`palette ${record.id}: required44px hit ownership clipped or intercepted`)
      if (record.paint.buttonRadius !== '50%' || record.paint.discRadius !== '50%' || record.paint.extensionFill !== 'rgba(0, 0, 0, 0)') throw Error(`palette ${record.id}: circular artwork or transparent extension changed`)
      const neighbor = buttons.nth((i + 1) % count)
      record.dispatches = []
      for (const index of [2, 4, 9, 10, 11, 12]) {
        const next = await neighbor.evaluate(el => { const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; return { id: el.dataset.accent, x, y, owned: document.elementFromPoint(x, y)?.closest('button') === el } })
        if (!next.owned) throw Error(`palette ${record.id}: neighbor centre is not reachable`)
        const point = record.samples[index], witnessed = record.id === 'turquoise' && index === 2
        if (witnessed) await phone.evaluate(paletteTapWitness, { target: record.id, neighbor: next.id, point: { x: point.x, y: point.y } })
        let gestureError
        try {
          if (witnessed) await phone.evaluate(() => window.__mobilePaletteTapWitness.mark('neighbor-before'))
          await phone.touchscreen.tap(next.x, next.y)
          const neighborColor = await selected(next.id)
          if (witnessed) await phone.evaluate(() => window.__mobilePaletteTapWitness.mark('neighbor-selected'))
          const dispatch = { index, x: point.x, y: point.y, neighborColor, ownedBeforeTap: await phone.evaluate(({ id, x, y }) => document.elementFromPoint(x, y)?.closest('button')?.dataset.accent === id, { id: record.id, x: point.x, y: point.y }) }
          record.dispatches.push(dispatch)
          if (!dispatch.ownedBeforeTap) throw Error(`palette ${record.id}: boundary ${index} changed owner before touch`)
          if (witnessed) await phone.evaluate(() => window.__mobilePaletteTapWitness.mark('target-before'))
          await phone.touchscreen.tap(point.x, point.y)
          if (witnessed) await phone.evaluate(() => window.__mobilePaletteTapWitness.mark('target-sent'))
          dispatch.targetColor = await selected(record.id)
          if (witnessed) await phone.evaluate(() => window.__mobilePaletteTapWitness.mark('target-selected'))
        } catch (error) {
          gestureError = error
          if (witnessed) try { await phone.evaluate(() => window.__mobilePaletteTapWitness.mark('target-wait-failure')) }
          catch (markError) { gestureError = new AggregateError([error, markError], `${error.message}\nwitness mark: ${markError.message}`) }
          throw gestureError
        } finally {
          if (witnessed) try { record.tapWitness = await phone.evaluate(() => window.__mobilePaletteTapWitness.stop('owner-finally')) }
          catch (error) { throw gestureError ? new AggregateError([gestureError, error], `${gestureError.message}\nwitness: ${error.message}`) : error }
        }
      }
      record.dispatch = true; record.neighborIsolated = true
    }
  } catch (error) {
    await reportFailure('primary', error)
  } finally {
    for (const row of records) if (!row.dispatch || !row.neighborIsolated) row.valid = false
    try {
      if (original) {
        const selector = `.settings .bb-accent[data-accent="${original}"]`, target = phone.locator(selector)
        await reveal(target); await stableBox({ page: phone }, selector, 1500)
        await target.click({ timeout: 3000 })
      }
    } catch (error) { await reportFailure('restoration', error) }
    try { await phone.evaluate(result => { window.__mobileEffectiveHits = result; const sheet = document.querySelector('.settings'); if (sheet) sheet.scrollTop = 0 }, records) }
    catch (error) { await reportFailure('recording', error) }
    if (failures.length === 1) throw failures[0].error
    if (failures.length > 1) throw new AggregateError(failures.map(f => f.error), String(failures[0].error.message) + failures.slice(1).map(f => `\n${f.stage}: ${String(f.error.message).split('\n')[0]}`).join(''))
  }
}

export async function mobileLayoutEvidence({ phone, screen, check, proof }) {
  const rows = [], frames = []
  let failure = 0
  const capture = async (name, row, options = {}) => {
    await proof.capture(phone, `mobile-${name}`, { mask: [phone.locator('#code-in'), phone.getByRole('textbox', { name: /code/i }), phone.locator('video')], ...(row.issues ? { failed: row.issues.length > 0 } : {}), ...options })
    frames.push(`mobile-${name}/0.png`)
    rows.push({ name, ...row })
  }
  const checked = (name, fn) => check(name, async () => {
    try { return await fn() }
    catch (error) { await capture(`failure-${++failure}`, { issues: [String(error.message)] }).catch(() => {}); throw error }
  })
  const paletteHits = () => paletteHitEvidence(phone, evidence => capture(`palette-hit-failure-${++failure}`, { issues: [evidence.reason], paletteErrorStage: evidence.stage, paletteHits: evidence.records, paletteScrolls: evidence.scrolls, beforeSelectionRestore: evidence.stage === 'primary' }))
  const measure = (clearanceOnly = false) => phone.evaluate(clearanceOnly => {
    const scope = document.querySelector('dialog[open] .sheet, .ctl-wrap:not(.out) .sheet, .sheet-wrap:not(.out) .settings') ?? document.querySelector('#surface')
    const issues = [], controls = []
    const box = r => ({ x: r.x, y: r.y, width: r.width, height: r.height })
    const notices = [...document.querySelectorAll('.obpal-notices .nt-item')].map(el => box(el.getBoundingClientRect())).filter(r => r.width && r.height)
    const bounds = scope?.getBoundingClientRect()
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('page horizontal overflow')
    for (const el of scope?.querySelectorAll('button') ?? []) {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el)
      if (!r.width || !r.height || style.visibility === 'hidden' || el.closest('[hidden], [inert]')) continue
      const top = Math.max(r.top, bounds?.top ?? 0, 0), bottom = Math.min(r.bottom, bounds?.bottom ?? innerHeight, innerHeight)
      if (clearanceOnly && bottom <= top) continue
      const label = el.getAttribute('aria-label') || el.textContent.trim()
      let rail = el.parentElement
      while (rail && rail !== scope && !/(auto|scroll)/.test(getComputedStyle(rail).overflowX)) rail = rail.parentElement
      const scrollable = rail && rail !== scope && rail.scrollWidth > rail.clientWidth + 1
      if (!scrollable && (r.left < -1 || r.right > innerWidth + 1)) issues.push(`${label}: outside horizontal viewport`)
      const effectiveHit = el.matches('.accent-row .bb-accent') ? window.__mobileEffectiveHits?.find(h => h.id === el.dataset.accent) : null
      if (!clearanceOnly && (r.width < 43.5 || r.height < 43.5) && !effectiveHit?.valid) issues.push(`${label}:44px effective hit ownership unproved`)
      for (const child of el.querySelectorAll('.action-label, .tray-label, .ctl-name')) {
        const range = document.createRange(); range.selectNodeContents(child)
        for (const text of range.getClientRects()) if (text.left < r.left - 1 || text.right > r.right + 1) issues.push(`${label}: text outside button`)
      }
      if (el.matches('[data-offered-stop]') && (r.top < 0 || r.bottom > innerHeight + 1)) issues.push('Stop not reachable in viewport')
      if (bottom > top && notices.some(n => r.right > n.x + 1 && r.left < n.x + n.width - 1 && bottom > n.y + 1 && top < n.y + n.height - 1)) issues.push(`${label}: notice overlaps visible control`)
      const column = el.matches('.set-row') ? el.querySelector(':scope > span:not(.set-srcs)') : null, subtitle = column?.querySelector('small')
      const textRects = (root, exclude) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), result = []
        while (walker.nextNode()) {
          const node = walker.currentNode
          if (!node.textContent.trim() || exclude?.contains(node)) continue
          const range = document.createRange(); range.selectNodeContents(node)
          result.push(...[...range.getClientRects()].map(box).filter(r => r.width > 0 && r.height > 0))
        }
        return result
      }
      const primary = subtitle ? textRects(column, subtitle) : [], secondary = subtitle ? textRects(subtitle) : []
      if (subtitle && (!primary.length || !secondary.length)) issues.push(`${label}: rendered primary or secondary text absent`)
      if (secondary.some(s => primary.some(p => p.y + p.height > s.y + 1))) issues.push(`${label}: primary and secondary text overlap`)
      controls.push({ label, x: r.x, y: r.y, w: r.width, h: r.height, horizontallyScrollable: !!scrollable, effectiveHit, ...(subtitle ? { primaryTextRects: primary, secondaryTextRects: secondary } : {}) })
    }
    const reservedHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--phone-notice-height')) || 0, spaceActive = document.documentElement.hasAttribute('data-phone-notices')
    const trust = document.querySelector('.obpal-notices .nt-item[data-id="trust"][data-tier="ceremony"]'), trustRect = trust ? box(trust.getBoundingClientRect()) : null
    const quiet = !!trust?.querySelector('.trust-first[data-quiet]')
    const visible = !!trustRect && trustRect.width > 0 && trustRect.height > 0 && trustRect.x >= -1 && trustRect.y >= -1 && trustRect.y + trustRect.height <= innerHeight + 1 && getComputedStyle(trust).visibility !== 'hidden' && Number(getComputedStyle(trust).opacity) >= 0.99
    const headerTargets = []
    if (clearanceOnly) {
      if (!quiet || !visible) issues.push('live quiet trust notice absent')
      const stackHeight = notices.length ? Math.max(...notices.map(r => r.y + r.height)) - Math.min(...notices.map(r => r.y)) : 0
      if (!spaceActive || !stackHeight || reservedHeight < stackHeight - 1) issues.push('live notice space not reserved')
      for (const [label, el] of [['Stop', scope?.querySelector('[data-offered-stop]')], ['Close', scope?.querySelector('#set-close')]]) {
        const r = el?.getBoundingClientRect(), owned = !!r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === el
        headerTargets.push({ label, rect: r ? box(r) : null, owned })
        if (!owned) issues.push(`${label}: header target not owned`)
        if (!r || r.width < 43.5 || r.height < 43.5 || r.top < -1 || r.bottom > innerHeight + 1) issues.push(`${label}: header target outside usable viewport`)
      }
    }
    return { at: performance.now(), clearanceOnly, viewport: { width: innerWidth, height: innerHeight }, scope: scope?.className ?? '', issues, controls, headerTargets, notices: { rectangles: notices, reservedHeight, spaceActive, trust: { present: !!trust, quiet, visible, rect: trustRect } } }
  }, clearanceOnly)
  const finish = async (name, extra = {}) => {
    await phone.waitForTimeout(220)
    const row = { ...await measure(), ...extra }
    await capture(name, row)
    if (row.issues.length) throw Error(row.issues.slice(0, 6).join('; '))
    return `${row.controls.length} measured controls`
  }
  const copyView = async (name, ids) => {
    const { initial: scroll, settled, recentered } = await revealSettingsCopy(phone, ids)
    const exposure = await phone.evaluate(scrollSettingsCopy, { ids, scroll: false })
    const row = { ...await measure(), copyScroll: scroll, copySettled: settled, copyRecenter: recentered, copyExposure: { before: exposure, after: null } }
    if (!exposure.fullyVisible) row.issues.push('copy group obscured by sticky header or footer')
    await capture(name, row)
    row.copyExposure.after = await phone.evaluate(scrollSettingsCopy, { ids, scroll: false })
    if (!row.copyExposure.after.fullyVisible) row.issues.push('copy group obscured during capture')
    if (row.issues.length) throw Error(row.issues.slice(0, 6).join('; '))
  }
  const closeLayers = async () => {
    for (let i = 0; i < 3; i++) {
      if (!(await phone.locator('.sheet-wrap:not(.out)').count())) break
      await phone.keyboard.press('Escape'); await sleep(240)
    }
  }
  await screen.evaluate(() => {
    window.__mobileBaseLayout = window.__obpal.layout
    window.__mobileButtons = []; window.__mobileInputs = 0; window.__mobileModes = 0
    window.__obpal.on('button', m => window.__mobileButtons.push({ id: m.id, ev: m.ev }))
    window.__obpal.on('input', () => window.__mobileInputs++)
    window.__obpal.on('mode', () => window.__mobileModes++)
  })
  const offer = async (id, label) => {
    const before = await phone.evaluate(() => window.__mobileLayoutVersion ?? 0)
    await screen.evaluate(({ id, label }) => {
      const base = window.__mobileBaseLayout
      window.__obpal.setLayout({ ...base, tray: [...base.tray.filter(c => c.tone !== 'stop'), ...(id ? [{ id, label, type: 'button', tone: 'stop' }] : [])] })
    }, { id, label })
    await until('fresh offered Stop layout delivered', () => phone.evaluate(({ before, ids }) => window.__mobileLayoutVersion > before && JSON.stringify(window.__mobileLastStopIds) === JSON.stringify(ids), { before, ids: id ? [id] : [] }))
  }
  try {
    await checked('mobile: genuine catalogue hint leaves landscape controls clear at667x375', async () => {
      await proof.expect(['mobile-667x375-catalogue-hint'])
      await closeLayers(); await phone.setViewportSize({ width: 667, height: 375 }); await phone.emulateMedia({ reducedMotion: 'reduce' })
      await offer('mobile-stop', 'Stop')
      await phone.bringToFront(); await phone.mouse.move(0, 0)
      const started = await phone.evaluate(() => performance.now())
      await phone.waitForFunction(() => [...document.querySelectorAll('.hint.in:not(.away)')].some(el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el)
        return el.querySelector('.hint-text')?.textContent === 'Browse the catalogue' && r.width > 0 && r.height > 0 && Number(s.opacity) >= .99 && s.visibility !== 'hidden'
      }), null, { timeout: 25000 })
      const before = await phone.evaluate(catalogueHintState)
      const row = { ...before, naturalWaitMs: before.at - started, hintCapture: { after: null }, qualification: 'Actual local Chromium hint after its real notice/queue lifetime; not physical iPhone/MacBook.' }
      await capture('667x375-catalogue-hint', row, { animations: 'allow' })
      row.hintCapture.after = await phone.evaluate(catalogueHintState)
      row.issues.push(...row.hintCapture.after.issues.map(issue => `after capture: ${issue}`))
      if (row.issues.length) throw Error(row.issues.slice(0, 6).join('; '))
      return 'genuine catalogue hint and exposed controls measured before and after capture'
    })
    await checked('mobile: the phone and actual viewer expose the same authenticated session seal', async () => {
      const seal = await until('phone verified seal', () => phone.locator('.link-badge .connection-seal[data-seal]').getAttribute('data-seal').catch(() => null))
      const matches = await screen.evaluate(value => window.__obpal.seals.some(s => s.seal.join('-') === value), seal)
      if (!matches) throw Error('phone seal differs from actual verified Viewer session')
      await capture('verified-viewer-seal', { authenticatedSealMatches: true, emulation: 'Chromium phone viewport, not physical Safari' })
      return 'seal matched the authenticated Viewer peer; no seal/code bytes recorded'
    })
    for (const [width, height] of [[320, 640], [360, 740], [390, 844], [430, 932], [667, 375], [844, 390]]) {
      await checked(`mobile: Options, Control and Actions bounds ${width}x${height}`, async () => {
        await proof.expect(['options', 'control', 'actions'].map(state => `mobile-${width}x${height}-${state}`))
        await closeLayers()
        await phone.setViewportSize({ width, height }); await phone.emulateMedia({ reducedMotion: 'reduce' })
        await offer('mobile-stop', 'Stop')
        await phone.locator('#ctl-more').click()
        await finish(`${width}x${height}-options`)
        await phone.keyboard.press('Escape'); await sleep(240)
        await finish(`${width}x${height}-control`)
        await phone.locator('#gear').click()
        await paletteHits()
        await finish(`${width}x${height}-actions`)
        await closeLayers()
      })
    }
    await checked('mobile: long labels and doubled computed text remain contained at320px', async () => {
      await proof.expect(['mobile-320-long-double-text', 'mobile-320-long-double-text-live-notice', 'mobile-320-long-double-text-scan-hand', 'mobile-320-long-double-text-lower-tools'])
      await closeLayers(); await phone.setViewportSize({ width: 320, height: 740 })
      await offer('mobile-stop', 'Stop all movement immediately')
      await phone.locator('#gear').click()
      await phone.evaluate(() => {
        const targets = [...document.querySelectorAll('.settings button, .settings span, .settings p, .settings label, .settings output')]
        window.__mobileFontSizes = targets.map(el => [el, el.style.fontSize, parseFloat(getComputedStyle(el).fontSize)])
        for (const [el, , size] of window.__mobileFontSizes) el.style.fontSize = `${size * 2}px`
      })
      try {
        await phone.waitForFunction(() => document.querySelector('.obpal-notices .nt-item[data-id="trust"][data-tier="ceremony"] .trust-first[data-quiet]'), null, { timeout: 8000 })
        await phone.waitForTimeout(220)
        const live = { ...await measure(true), liveCapture: { after: null } }
        // Observe the existing notice before the long palette sweep, without changing its clock or animation.
        await capture('320-long-double-text-live-notice', live, { animations: 'allow', failed: live.issues.length ? true : undefined })
        const after = await measure(true)
        live.liveCapture.after = { at: after.at, notices: after.notices, headerTargets: after.headerTargets, issues: after.issues }
        live.issues.push(...after.issues.map(issue => `after capture: ${issue}`))
        if (live.issues.length) throw Error(live.issues.slice(0, 6).join('; '))
        await paletteHits()
        const result = await finish('320-long-double-text', { textSizing: 'Synthetic doubled computed text sizes; not OS accessibility settings' })
        await copyView('320-long-double-text-scan-hand', ['scan-open', 'hand-settings'])
        await copyView('320-long-double-text-lower-tools', ['buttons-open', 'connections-open', 'connection-details'])
        return result
      }
      finally { await phone.evaluate(() => { for (const [el, old] of window.__mobileFontSizes ?? []) el.style.fontSize = old }); await closeLayers() }
    })
    await checked('mobile: an open chooser releases held Wii input and pauses covered frames', async () => {
      await proof.expect(['mobile-held-release'])
      await closeLayers(); await phone.setViewportSize({ width: 390, height: 844 })
      await phone.locator('[data-tab="point"]').click()
      await phone.keyboard.down('AudioVolumeDown')
      await until('held B', () => screen.evaluate(() => window.__mobileButtons.some(m => m.id === 'wii-b' && m.ev === 'down')))
      await phone.locator('#ctl-more').click(); await phone.keyboard.up('AudioVolumeDown')
      await until('released B', () => screen.evaluate(() => window.__mobileButtons.some(m => m.id === 'wii-b' && m.ev === 'up')))
      await sleep(150); await screen.evaluate(() => { window.__mobileInputs = 0 }); await sleep(350)
      const inputs = await screen.evaluate(() => window.__mobileInputs)
      await capture('held-release', { coveredInputFrames: inputs, heldButtonReleased: true })
      if (inputs) throw Error(`${inputs} control frames under open chooser`)
      await phone.keyboard.press('Escape'); await sleep(240)
      await phone.locator('[data-tab="rotate"]').click()
    })
    await checked('mobile: open Options and Settings refresh Stop addition, replacement and removal', async () => {
      await proof.expect(['mobile-options-stop-refreshed', 'mobile-settings-stop-refreshed'])
      for (const layer of ['options', 'settings']) {
        await closeLayers(); await offer(null, '')
        await phone.locator(layer === 'options' ? '#ctl-more' : '#gear').click()
        const active = phone.locator(layer === 'options' ? '.ctl-wrap:not(.out)' : '.sheet-wrap:not(.out):has(.settings)')
        await until('delivered Stop-free layout reflected', async () => await active.locator('[data-offered-stop]').count() === 0)
        await offer('mobile-stop-a', 'Stop A')
        await active.locator('[data-offered-stop]').getByText('Stop A', { exact: true }).waitFor()
        await offer('mobile-stop-b', 'Stop B')
        await active.locator('[data-offered-stop]').getByText('Stop B', { exact: true }).waitFor()
        await active.locator('[data-offered-stop]').click()
        await until('current offered Stop received', () => screen.evaluate(() => window.__mobileButtons.some(m => m.id === 'mobile-stop-b' && m.ev === 'tap')))
        await offer(null, '')
        await until('Stop removed', async () => await active.locator('[data-offered-stop]').count() === 0)
        await capture(`${layer}-stop-refreshed`, { added: true, changed: true, removed: true })
      }
    })
  } finally {
    await closeLayers().catch(() => {})
    await phone.setViewportSize({ width: 390, height: 844 }).catch(() => {})
    await screen.evaluate(() => window.__obpal.setLayout(window.__mobileBaseLayout)).catch(() => {})
    await writeFile(join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'mobile-layout.json'), JSON.stringify({ source: process.env.OBPAL_E2E_SOURCE_SHA, rows, captures: frames, physicalSafari: false }, null, 2))
  }
}
