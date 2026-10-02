/** Use the menu's theme path and wait for its colour transitions before sampling inherited text colours. */
export async function setSurface(page, theme) {
  await page.waitForFunction(() => window.BlackboxesFamily)
  await page.evaluate(async theme => {
    window.BlackboxesFamily.setTheme(theme)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    // A cancelled transition can be idle by the time its finished promise is read; that new promise never settles.
    const deadline = performance.now() + 5000
    while (document.getAnimations().some(animation => animation instanceof CSSTransition && !['finished', 'idle'].includes(animation.playState))) {
      if (performance.now() >= deadline) throw new Error('Theme transitions did not settle within 5 s')
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, theme)
}

/** The rendered overlay must obscure the page and keep its text readable, including over a bright scene. */
export async function checkFrost(page, selector, { maxHeight = Infinity, solid = false, text = [] } = {}) {
  const found = await page.locator(selector).evaluate((el, text) => {
    const style = getComputedStyle(el)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d')
    const rgba = color => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
      return [...ctx.getImageData(0, 0, 1, 1).data]
    }
    const background = rgba(style.backgroundColor)
    const luminance = rgb => rgb.slice(0, 3).map(c => {
      const v = c / 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const contrast = color => Math.min(...[0, 255].map(behind => {
      const bg = background.slice(0, 3).map(c => c * background[3] / 255 + behind * (1 - background[3] / 255))
      const fg = rgba(color)
      const a = luminance(bg), b = luminance(fg.slice(0, 3).map((c, i) => c * fg[3] / 255 + bg[i] * (1 - fg[3] / 255)))
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }))
    return {
      height: el.getBoundingClientRect().height,
      alpha: background[3] / 255,
      blur: style.backdropFilter || style.webkitBackdropFilter,
      supported: CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'),
      contrast: text.flatMap(selector => [...el.querySelectorAll(selector)].filter(node => node.getClientRects().length && !node.disabled).map(node => ({
        text: node.textContent?.trim().slice(0, 50) || node.getAttribute('aria-label') || selector,
        ratio: contrast(getComputedStyle(node).color),
      }))),
    }
  }, text)
  if (found.height > maxHeight) throw new Error(`${selector}: ${found.height}px high, limit ${maxHeight}px`)
  if (found.alpha < (solid || !found.supported ? 1 : 0.6)) throw new Error(`${selector}: background alpha ${found.alpha}`)
  if (!solid && found.supported && (!found.blur || found.blur === 'none')) throw new Error(`${selector}: no backdrop filter`)
  const unreadable = found.contrast.filter(c => c.ratio < 4.5)
  if (unreadable.length) throw new Error(`${selector}: contrast below AA ${JSON.stringify(unreadable)}`)
  return `${Math.round(found.height)}px; alpha ${found.alpha.toFixed(2)}; ${found.blur}`
}
