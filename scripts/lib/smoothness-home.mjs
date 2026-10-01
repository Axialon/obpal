/** The home field's scheduling, containment and frame-loop layout reads, measured after a separate warm-up. */
export async function prepareHomeSmoothness(context) {
  await context.addInitScript(() => {
    const probe = window.__fieldProbe = { layoutReads: 0, readStacks: [], frames: [], longTasks: [], cls: 0, shifts: [], lcp: 0, measuring: false }
    let inFrame = false
    const raf = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = fn => raf(t => {
      inFrame = true
      try { fn(t) } finally { inFrame = false }
    })
    for (const [owner, key] of [[Element.prototype, 'getBoundingClientRect'], [Element.prototype, 'getClientRects'], [Range.prototype, 'getBoundingClientRect'], [Range.prototype, 'getClientRects'], [window, 'getComputedStyle']]) {
      const original = owner[key]
      owner[key] = function (...args) {
        if (inFrame && probe.measuring) { probe.layoutReads++; if (probe.readStacks.length < 4) probe.readStacks.push(new Error(key).stack) }
        return original.apply(this, args)
      }
    }
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (probe.measuring) probe.longTasks.push({ start: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: true })
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) { probe.cls += entry.value; probe.shifts.push({ at: entry.startTime, value: entry.value, sources: entry.sources?.map(s => ({ node: s.node?.className, previous: s.previousRect, current: s.currentRect })) }) }
    }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) probe.lcp = entry.startTime
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  })
}

export async function measureHomeSmoothness(page, seconds = 10) {
  return page.evaluate(async seconds => {
    const probe = window.__fieldProbe
    probe.measuring = true
    probe.layoutReads = 0; probe.longTasks = []; probe.readStacks = []
    const initialCls = probe.cls
    const initial = window.__home.activity()
    const intervals = [], frames = [], escapes = []
    const maxScroll = document.documentElement.scrollHeight - innerHeight
    let begin = 0, previous = 0
    await new Promise(resolve => {
      function sample(t) {
        if (!begin) begin = previous = t
        else intervals.push(t - previous)
        previous = t
        const elapsed = t - begin
        // A full pass and reversal; only numeric scroll writes, never scroll-linked layout reads.
        const progress = Math.min(1, elapsed / (seconds * 1000))
        scrollTo(0, maxScroll * (1 - Math.abs(1 - progress * 2)))
        const tips = window.__home.tips(), outlines = tips.map(m => window.__home.outline(m.id))
        for (const outline of outlines) {
          if (!outline || outline.left < -1 || outline.right > innerWidth + 1 || outline.top < outline.area.top - 1 || outline.bottom > outline.area.bottom + 1) escapes.push({ elapsed, outline })
        }
        frames.push({ t, tips, outlines, activity: window.__home.activity() })
        if (elapsed < seconds * 1000) requestAnimationFrame(sample)
        else resolve()
      }
      requestAnimationFrame(sample)
    })
    probe.measuring = false
    const sorted = [...intervals].sort((a, b) => a - b)
    const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    return { samples: intervals.length, median: percentile(.5), p95: percentile(.95), max: sorted.at(-1), intervals, frames,
      escapes, layoutReads: probe.layoutReads, readStacks: probe.readStacks, longTasks: probe.longTasks, cls: probe.cls - initialCls, initialCls, lcp: probe.lcp, shifts: probe.shifts,
      layoutsDuringScroll: window.__home.activity().layouts - initial.layouts }
  }, seconds)
}
