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

/** Opt into the measured Windows D3D11 path; keep every suite's existing options when unset. */
export function e2eBrowserOptions(options, env = process.env, platform = process.platform) {
  if (env.OBPAL_E2E_GPU === 'swiftshader') {
    const args = (options.args ?? []).filter(arg => !arg.startsWith('--use-angle=') &&
      !['--enable-unsafe-swiftshader', '--enable-gpu', '--ignore-gpu-blocklist'].includes(arg))
    return { ...options, args: [...args, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
  }
  if (env.OBPAL_E2E_GPU !== '1') return options
  if (platform !== 'win32') throw new Error('OBPAL_E2E_GPU=1 requires Windows; only D3D11 was measured')
  const args = (options.args ?? []).filter(arg => !arg.startsWith('--use-angle=') &&
    !['--enable-unsafe-swiftshader', '--enable-gpu', '--ignore-gpu-blocklist'].includes(arg))
  return { ...options, args: [...args, '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] }
}

/** Probe the actual WebGL renderer; a missing or software device uses the explicit software fallback. */
export async function detectE2eGpu(executablePath, { platform = process.platform, launch } = {}) {
  if (platform !== 'win32') return { hardware: false, renderer: '', reason: 'D3D11 requires Windows' }
  const start = launch || (options => import('playwright').then(({ chromium }) => chromium.launch(options)))
  const browser = await start(e2eBrowserOptions({ executablePath: executablePath || undefined, headless: true, timeout: 30_000 }, { OBPAL_E2E_GPU: '1' }, platform))
  try {
    const page = await browser.newPage()
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2')
      const info = gl?.getExtension('WEBGL_debug_renderer_info')
      return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
    })
    const hardware = !!renderer && !/swiftshader|software|llvmpipe|basic render|warp/i.test(renderer)
    return { hardware, renderer, reason: hardware ? '' : 'no hardware WebGL renderer detected' }
  } finally { await browser.close() }
}
