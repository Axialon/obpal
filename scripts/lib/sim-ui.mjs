/**
 * A sim's controls, reached the way a person reaches them, for the e2e checks. Its windows (src/sim/ui/panels.ts) start
 * docked on phones and small screens, so a control inside one is pressed by opening that window from the dock (behind
 * the dock's tab where a touch screen keeps the rail off the edge) and docking it again after. The quick-actions tray's
 * camera (src/ui/quick.ts) steps through the views, first person among them: on a touch screen, one press away.
 */

/** Opens a window from the dock if it's docked. True if it was. */
export async function openWindow(page, id, { touch = false } = {}) {
  const win = page.locator(`[data-panel="${id}"]`)
  if (await win.isVisible()) return false
  const press = (locator) => (touch ? locator.tap() : locator.click())
  const handle = page.locator('.panel-dock-handle')
  if (await handle.isVisible() && (await handle.getAttribute('aria-expanded')) !== 'true') await press(handle)
  await press(page.locator(`[data-panel-toggle="${id}"]`))
  await win.waitFor({ state: 'visible' })
  return true
}

/**
 * Presses the button named `name` in window `id` where it shows there, opening the window from the dock for it and
 * docking it again after. False if the page has no such window or button.
 */
export async function pressInWindow(page, id, name, { touch = false } = {}) {
  const win = page.locator(`[data-panel="${id}"]`)
  if (!(await win.count())) return false
  const press = (locator) => (touch ? locator.tap() : locator.click())
  const docked = await openWindow(page, id, { touch })
  const button = win.getByRole('button', { name, exact: true }).filter({ visible: true })
  const has = (await button.count()) > 0
  if (has) await press(button.first())
  if (docked) await press(win.getByRole('button', { name: /^Minimise / }))
  return has
}

/**
 * Steps the tray's camera until `there(page)` holds, opening the tray as needed, then closes it (Escape, from inside
 * it) so it covers nothing. Returns how many presses it took; throws if a round of its views never gets there.
 */
export async function trayCamera(page, there, { touch = false } = {}) {
  const press = (locator) => (touch ? locator.tap() : locator.click())
  const tray = page.locator('.quick-tray'), camera = tray.locator('[data-quick="camera"]')
  const open = async () => (await tray.getAttribute('data-open')) === 'true'
  let presses = 0
  while (!(await there(page))) {
    if (presses === 8) throw new Error('the tray’s camera went round its views and never got there')
    if (!(await open())) await press(page.locator('.quick-tab'))
    await press(camera)
    presses++
    await page.waitForTimeout(150)
  }
  if (await open()) { await camera.focus(); await page.keyboard.press('Escape') }
  return presses
}
