/**
 * The Chromium the dev tools drive: OBPAL_E2E_CHROMIUM if set, else Playwright's own full Chromium
 * (npx playwright install chromium), else the newest full Chromium an earlier Playwright installed beside it. The
 * headless shell Playwright picks by default can't load extensions or lock orientation, so the suites want the full
 * one. Only files are looked at: never start a browser to ask its version.
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

/** @returns {Promise<{ path: string, from: string }>} path '' when none is installed. Throws when the env names a missing file. */
export async function resolveChromium(env = process.env) {
  const set = env.OBPAL_E2E_CHROMIUM
  if (set) {
    if (!existsSync(set)) throw new Error(`OBPAL_E2E_CHROMIUM names a file that isn't there: ${set}`)
    return { path: set, from: 'OBPAL_E2E_CHROMIUM' }
  }
  let wanted = ''
  try {
    const { chromium } = await import('playwright')
    wanted = chromium.executablePath()
  } catch { /* no Playwright here */ }
  if (wanted && existsSync(wanted)) return { path: wanted, from: "Playwright's Chromium" }
  const older = wanted && newestInstalled(wanted)
  if (older) return { path: older, from: `an earlier Playwright's Chromium (${basename(dirname(dirname(older)))}; this one wants ${basename(dirname(dirname(wanted)))})` }
  return { path: '', from: "none found (npx playwright install chromium); Playwright's default" }
}

/**
 * The newest chromium-<revision> folder beside the one Playwright wants that holds the browser at the same place
 * inside it (chrome-win64/chrome.exe and the like). Not the headless shells.
 */
export function newestInstalled(wanted) {
  const revision = dirname(dirname(wanted))
  const store = dirname(revision)
  const inside = relative(revision, wanted)
  let names = []
  try { names = readdirSync(store) } catch { return '' }
  const found = names.map((n) => /^chromium-(\d+)$/.exec(n)).filter(Boolean).sort((a, b) => Number(b[1]) - Number(a[1]))
    .map((m) => join(store, m[0], inside)).find((p) => existsSync(p))
  return found ?? ''
}

/** The last three parts of a browser's path, enough to tell which one without printing a home folder. */
export const shortPath = (p) => (p ? `…/${p.split(/[\\/]/).slice(-3).join('/')}` : '')
