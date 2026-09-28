/**
 * The offline viewer for the UI system's evidence in artifacts/ui-system-2/ (git ignores it): phase 2's sims before
 * and after (scripts/capture-sims.mjs), and phase 3's quick-actions tray (scripts/capture-quick.mjs). Each capture
 * script writes its pictures, then this page from whatever pictures are there.
 */
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const SIMS = [
  ['arm', '/sim/arm/'], ['arena', '/sim/arena/'], ['drone', '/sim/device/?d=drone'], ['rover', '/sim/device/?d=rover'],
  ['kart', '/sim/device/?d=kart'], ['gimbal', '/sim/device/?d=gimbal'], ['ptz', '/sim/device/?d=ptz'],
  ['studio', '/sim/device/?d=studio'], ['smarthome', '/sim/device/?d=smarthome'], ['pinball', '/sim/device/?d=pinball'],
]
/** Phase 3's pages: a site page, the hub, a sim and the viewer. */
export const TRAY_PAGES = [['home', '/'], ['hub', '/sim/'], ['sim', '/sim/drone/'], ['viewer', '/view/']]
export const SIZES = [[1920, 1080], [1440, 900], [390, 844], [844, 390]]
export const phone = (w, h) => w <= 700 || h <= 500

export async function writeViewer(out, errors = []) {
  const files = (await readdir(out)).sort()
  const shots = files.filter((f) => f.endsWith('.png'))
  const title = (f) => f.replace(/\.(png|webm)$/, '').replaceAll('-', ' ')
  const figure = (f, caption) => shots.includes(f) ? `<figure><figcaption>${caption}</figcaption><a href="${f}"><img loading="lazy" src="${f}" alt="${title(f)}"></a></figure>` : ''
  /** Before and after at each size, and each extra view (a suffix, its caption, whether only on phones). */
  const pairs = (name, before, after, extras = []) => SIZES.map(([w, h]) => {
    const s = `${w}x${h}`
    const list = [[`${before}${name}-${s}.png`, 'Before'], [`${after}${name}-${s}.png`, 'After']]
    for (const x of extras) if (!x.phoneOnly || phone(w, h)) list.push([`${before}${name}-${s}${x.suffix}.png`, `Before, ${x.caption}`], [`${after}${name}-${s}${x.suffix}.png`, `After, ${x.caption}`])
    return `<h3>${s}</h3><div class="pair">${list.map(([f, c]) => figure(f, c)).join('')}</div>`
  }).join('')
  const sims = SIMS.map(([name]) => `<section class="sim" id="${name}"><h2>${name}</h2>${pairs(name, 'before-', 'after-', [{ suffix: '-controls', caption: 'controls open', phoneOnly: true }])}</section>`).join('\n')
  const extra = shots.filter((f) => /^after-(dock|moving|camera)/.test(f)).map((f) => figure(f, title(f))).join('')
  const trayPages = TRAY_PAGES.map(([name]) => `<section class="sim" id="tray-${name}"><h2>${name}</h2>${pairs(name, 'phase3-before-', 'phase3-after-', [{ suffix: '-open', caption: 'tray open' }])}</section>`).join('\n')
  const trayShots = shots.filter((f) => /^phase3-(action|tray)-/.test(f)).map((f) => figure(f, title(f))).join('')
  const videos = files.filter((f) => f.startsWith('phase3-') && f.endsWith('.webm'))
    .map((f) => `<figure><figcaption>${title(f)}</figcaption><video controls muted loop playsinline preload="metadata" src="${f}"></video></figure>`).join('')
  const phase3 = files.some((f) => f.startsWith('phase3-'))
  await writeFile(join(out, 'index.html'), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ob.Pal · UI system review</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#101316;color:#eef3ec}body{max-width:1680px;margin:auto;padding:28px}h1{font-size:clamp(28px,4vw,48px);letter-spacing:-.04em;margin:8px 0 10px}h1 span{color:#c6ff34}h2{margin:44px 0 6px;font-size:22px;text-transform:capitalize}h3{margin:18px 0 10px;font:600 13px ui-monospace,monospace;color:#c6ff34}p{color:#adb9af;max-width:900px;line-height:1.6}a{color:#c6ff34}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px}figure{margin:0;background:#171d1a;border:1px solid #2c3530;border-radius:16px;overflow:hidden}figure img,figure video{display:block;width:100%;height:auto;max-height:640px;object-fit:contain;background:#0a0c0b}figcaption{padding:10px 14px;font-size:13px;color:#c6cec4}nav{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:14px;padding:12px 0;background:#101316ee;border-bottom:1px solid #2c3530;text-transform:capitalize}.phase{margin-top:72px;padding-top:28px;border-top:2px solid #c6ff34}@media(max-width:700px){body{padding:16px}}
</style>
<small style="color:#c6ff34;letter-spacing:.12em;text-transform:uppercase;font-size:12px">ob.Pal · UI system, phases 2 and 3</small>
<h1>Inside the sims: <span>widget cards, not pills</span></h1>
<p>Ten sims before and after at 1920×1080, 1440×900, 390×844 and 844×390; on a phone the windows start docked, so each phone size also shows the controls window open. Then the dock with a tooltip, a window being moved, and a camera window enlarged. Click an image for full size.${errors.length ? ` <b style="color:#fb7185">Capture errors: ${errors.length}</b>` : ''}</p>
<nav>${SIMS.map(([n]) => `<a href="#${n}">${n}</a>`).join('')}${extra ? '<a href="#more">Dock and windows</a>' : ''}${phase3 ? '<a href="#phase-3">Phase 3: quick actions</a>' : ''}</nav>
${sims}
${extra ? `<section id="more"><h2>Dock and windows</h2><div class="pair">${extra}</div></section>` : ''}
${phase3 ? `<section class="phase" id="phase-3"><small style="color:#c6ff34;letter-spacing:.12em;text-transform:uppercase;font-size:12px">Phase 3</small><h1>Quick actions: <span>a tray at the edge</span></h1>
<p>A slim glass tab on the right edge of every ob.Pal page slides out the actions that apply there: pair a phone, camera view, fullscreen, sound, theme and reset on a sim; fewer on the site's pages. Home, the sims hub, a sim and the viewer, before and after, closed and open, at the same four sizes; then its actions in use and a short recording.</p>
${videos ? `<h2>Recording</h2><div class="pair">${videos}</div>` : ''}
${trayShots ? `<h2>Its actions in use</h2><div class="pair">${trayShots}</div>` : ''}
${trayPages}</section>` : ''}
</html>\n`)
  return shots.length
}
