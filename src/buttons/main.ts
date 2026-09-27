/**
 * The buttons diagnostic (/buttons/): which physical inputs reach a web page on this phone, live and large enough to
 * read on it.
 *  - Every key event: the volume keys (held with preventDefault, or let through), a Bluetooth keyboard, remote,
 *    clicker or selfie remote. The page can't read the phone's volume, so it asks once whether the volume moved.
 *  - Media Session actions from headset and earbud buttons: an opt-in, because it plays a silent track, which takes
 *    the audio focus and pauses the person's music.
 *  - Connected gamepads: buttons and axes by index, the mapping, and a rumble test.
 *  - The Back button or gesture: an opt-in, through CloseWatcher where there is one, else the history.
 * A one-line summary copies to paste back. Nothing here connects to a screen. The findings it checks are in
 * spec/RESEARCH-BUTTONS.md; the pure half (input ids, labels, the summary) is ./inputs.ts.
 */
import { applyTheme, initialTheme } from '../ui/themes'
import { ICONS, mountMarks } from '../ui/icons'
import { mountTopBar } from '../landing/topbar'
import {
  describeEnv, emptyTally, isTrack, keyInput, labelOf, mediaInput, padAxis, padButton, padName, sourceOf, summarize, trackWav,
  TRACKS, type Source, type Tally, type Track,
} from './inputs'

applyTheme(initialTheme())
mountMarks()
mountTopBar()

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const s = (d: string) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
const GLYPH: Record<Source, string> = {
  keys: ICONS.keyboard,
  volume: ICONS.sound,
  media: s('<path d="M4.5 14.5v-2a7.5 7.5 0 0 1 15 0v2"/><rect x="3.5" y="13.5" width="4.2" height="6.5" rx="1.8"/><rect x="16.3" y="13.5" width="4.2" height="6.5" rx="1.8"/>'),
  pad: ICONS.gamepad,
  back: s('<path d="M9.5 7.5 5 12l4.5 4.5"/><path d="M5.5 12h8.5a4.5 4.5 0 0 1 0 9h-2"/>'),
}
const SOURCES: [Source, string][] = [['keys', 'Keys'], ['volume', 'Volume'], ['media', 'Headset'], ['pad', 'Pad'], ['back', 'Back']]

// ---- what's been seen, kept for this tab so a Back that leaves (or a reload) doesn't lose it ----
interface Row { at: number; id: string; source: Source | 'info'; label: string; detail: string; repeats: number; held?: number }
const STORE = 'obpal.buttons'
const MAX_ROWS = 60
let tally: Tally = emptyTally()
let rows: Row[] = []
try {
  const saved = JSON.parse(sessionStorage.getItem(STORE) ?? 'null') as { tally: Tally; rows: Row[] } | null
  if (saved?.tally?.inputs && Array.isArray(saved.rows)) { tally = { ...emptyTally(), ...saved.tally }; rows = saved.rows.slice(0, MAX_ROWS) }
} catch { /* blocked storage: start fresh */ }
// Opt-ins start again from a tap: a new page has no audio playing and no Back armed.
tally.headset = tally.headset === 'failed' ? 'failed' : 'off'
if (!isTrack(tally.track)) tally.track = '10s'
tally.back.on = false
let saveTimer: ReturnType<typeof setTimeout> | undefined
function changed() {
  renderSources()
  $('sum').textContent = summarize(tally)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { try { sessionStorage.setItem(STORE, JSON.stringify({ tally, rows })) } catch { /* full or blocked */ } }, 250)
}

// ---- where the page runs ----
function displayMode(): string {
  let twa = false
  try {
    twa = document.referrer.startsWith('android-app://') || sessionStorage.getItem(`${STORE}.twa`) === '1'
    if (twa) sessionStorage.setItem(`${STORE}.twa`, '1')
  } catch { /* blocked storage */ }
  if (twa) return 'twa'
  if ((navigator as Navigator & { standalone?: boolean }).standalone) return 'home screen'
  for (const m of ['fullscreen', 'standalone', 'minimal-ui']) if (matchMedia(`(display-mode: ${m})`).matches) return m
  return 'browser'
}
type UaData = { brands?: { brand: string; version: string }[]; getHighEntropyValues?: (h: string[]) => Promise<{ platformVersion?: string; model?: string }> }
const uad = (navigator as Navigator & { userAgentData?: UaData }).userAgentData
const env = { ua: navigator.userAgent, brands: uad?.brands, touch: navigator.maxTouchPoints > 1, mode: displayMode() }
function showEnv(more: { platformVersion?: string; model?: string } = {}) {
  tally.env = describeEnv({ ...env, ...more })
  $('env').textContent = tally.env
  changed()
}
showEnv()
void uad?.getHighEntropyValues?.(['platformVersion', 'model']).then(showEnv, () => {})

// ---- the page ----
$('srcs').innerHTML = SOURCES.map(([src, name]) => `<div class="bt-src" data-src="${src}">${GLYPH[src]}<b>0</b><span>${name}</span></div>`).join('')
$('hold').insertAdjacentHTML('afterbegin', ICONS.sound)
$('headset').insertAdjacentHTML('afterbegin', GLYPH.media)
$('back').insertAdjacentHTML('afterbegin', GLYPH.back)
$('fs').innerHTML = ICONS.frame
$('clear').innerHTML = ICONS.reset

function renderSources() {
  const counts: Record<Source, number> = { keys: 0, volume: 0, media: 0, pad: 0, back: 0 }
  for (const [id, n] of Object.entries(tally.inputs)) counts[sourceOf(id)] += n
  for (const el of document.querySelectorAll<HTMLElement>('.bt-src')) {
    const n = counts[el.dataset.src as Source]
    el.querySelector('b')!.textContent = String(n)
    el.toggleAttribute('data-on', n > 0)
  }
}

const clock = (t: number) => new Date(t).toTimeString().slice(0, 8)
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
function renderLog() {
  $('log').innerHTML = rows.length
    ? rows.map((r) => {
      const extra = [r.repeats ? `${r.repeats} repeats` : '', r.held !== undefined ? `held ${Math.round(r.held)} ms` : ''].filter(Boolean).join(' · ')
      return `<li data-src="${r.source}"><i></i><b>${esc(r.label)}</b><span>${esc(r.detail)}${extra ? ` · ${extra}` : ''}</span><time>${clock(r.at)}</time></li>`
    }).join('')
    : '<li class="empty">Nothing yet</li>'
}

const heroEl = $('hero')
function hero(id: string, detail: string) {
  $('last').textContent = labelOf(id)
  $('sub').textContent = detail
  heroEl.dataset.src = sourceOf(id)
  heroEl.classList.remove('hit')
  void heroEl.offsetWidth
  heroEl.classList.add('hit')
}

/** One press of an input: counted, logged and shown. */
function input(id: string, detail: string): Row {
  tally.inputs[id] = (tally.inputs[id] ?? 0) + 1
  if (document.fullscreenElement) tally.fullscreen = true
  const flags = [document.fullscreenElement ? 'fullscreen' : '', document.hidden ? 'hidden' : ''].filter(Boolean)
  const row: Row = { at: Date.now(), id, source: sourceOf(id), label: labelOf(id), detail: [detail, ...flags].join(' · '), repeats: 0 }
  rows.unshift(row)
  rows.length = Math.min(rows.length, MAX_ROWS)
  hero(id, row.detail)
  renderLog()
  changed()
  return row
}
/** Something the phone did rather than a press (fullscreen, the page hidden, the track paused): logged, not counted. */
function info(text: string) {
  rows.unshift({ at: Date.now(), id: '', source: 'info', label: '·', detail: text, repeats: 0 })
  rows.length = Math.min(rows.length, MAX_ROWS)
  renderLog()
  changed()
}

// ---- keys ----
const down = new Map<string, { at: number; row: Row }>()
/** Focus a keyboard put there (Safari before 15.4 doesn't know the selector: no). */
const focusVisible = (el: Element) => { try { return el.matches(':focus-visible') } catch { return false } }
function onKey(e: KeyboardEvent, isDown: boolean) {
  const id = keyInput(e)
  const volume = sourceOf(id) === 'volume'
  const t = e.target as HTMLElement | null
  // A keyboard user's Enter or Space on a button they tabbed to still presses it. Anything else is only logged: a
  // clicker's Enter must not press the last button tapped, and its arrows or Page Down mustn't scroll the log away.
  const pressing = (e.key === 'Enter' || e.key === ' ') && !!t?.closest?.('button, a') && focusVisible(t)
  if (!pressing && e.key !== 'Tab' && (!volume || tally.volume.hold)) e.preventDefault()
  const detail = `${e.key === ' ' ? 'Space' : e.key || 'no key'} · ${e.code || 'no code'} · #${e.keyCode}${e.defaultPrevented ? ' · prevented' : ''}`
  if (isDown) {
    const held = down.get(id)
    if (e.repeat && held) { held.row.repeats++; renderLog(); return }
    down.set(id, { at: e.timeStamp, row: input(id, detail) })
    if (volume) askVolume()
    return
  }
  const held = down.get(id)
  down.delete(id)
  if (held) { held.row.held = e.timeStamp - held.at; renderLog(); changed(); return }
  // Some remotes and browsers send only the release.
  input(id, `${detail} · up only`)
}
addEventListener('keydown', (e) => onKey(e, true), { capture: true })
addEventListener('keyup', (e) => onKey(e, false), { capture: true })
addEventListener('blur', () => down.clear())

// The volume keys: held (preventDefault) or let through. Whether the volume still moved only the person can see.
const holdBtn = $('hold')
function renderHold() { holdBtn.setAttribute('aria-pressed', String(tally.volume.hold)) }
holdBtn.onclick = () => { tally.volume.hold = !tally.volume.hold; renderHold(); $('ask').hidden = true; changed() }
function askVolume() {
  const known = tally.volume.hold ? tally.volume.movedHeld : tally.volume.movedFree
  if (known !== undefined) return
  $('ask-q').textContent = tally.volume.hold ? 'Held: did the volume still move?' : 'Did the volume move?'
  $('ask').hidden = false
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#ask [data-moved]')) {
  b.onclick = () => {
    const moved = b.dataset.moved === '1'
    if (tally.volume.hold) tally.volume.movedHeld = moved
    else tally.volume.movedFree = moved
    $('ask').hidden = true
    changed()
  }
}

// ---- headset and earbud buttons (Media Session) ----
const ACTIONS = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'seekforward', 'seekbackward', 'seekto', 'skipad',
  'hangup', 'togglemicrophone', 'togglecamera', 'togglescreenshare', 'previousslide', 'nextslide', 'enterpictureinpicture', 'voiceactivity']
let audio: HTMLAudioElement | null = null
let trackUrl = ''
/** Our own pause (turning it off, or changing the track) isn't the phone taking the audio away. */
let pausing = false
const headsetBtn = $('headset')
function renderHeadset() {
  headsetBtn.setAttribute('aria-pressed', String(tally.headset === 'on'))
  headsetBtn.classList.toggle('failed', tally.headset === 'failed')
  $('track').hidden = tally.headset !== 'on'
  for (const b of document.querySelectorAll<HTMLButtonElement>('#track [data-track]')) b.setAttribute('aria-checked', String(b.dataset.track === tally.track))
  $('note').textContent = tally.headset === 'on' ? 'Plays silence · pauses your music · press your headset button'
    : tally.headset === 'failed' ? 'No headset buttons in this browser' : ''
}
function useTrack(track: Track) {
  if (trackUrl) URL.revokeObjectURL(trackUrl)
  trackUrl = URL.createObjectURL(new Blob([trackWav(TRACKS[track].seconds, TRACKS[track].faint) as BlobPart], { type: 'audio/wav' }))
  tally.track = track
  if (!audio) {
    audio = new Audio()
    audio.loop = true
    audio.addEventListener('pause', () => { if (!pausing && tally.headset === 'on') info('The phone paused the track') })
  }
  pausing = true
  audio.src = trackUrl
  pausing = false
}
async function headsetOn(): Promise<boolean> {
  if (!('mediaSession' in navigator)) return false
  if (!audio || !trackUrl) useTrack(tally.track)
  try { await audio!.play() } catch { return false }
  const session = navigator.mediaSession
  try {
    session.metadata = new MediaMetadata({ title: 'Buttons test', artist: 'ob.Pal', artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] })
  } catch { /* no metadata */ }
  const took: string[] = []
  for (const action of ACTIONS) {
    try {
      session.setActionHandler(action as MediaSessionAction, (d) => {
        const extra = [d.seekOffset !== undefined ? `offset ${d.seekOffset}` : '', d.seekTime !== undefined ? `to ${d.seekTime.toFixed(1)}` : ''].filter(Boolean)
        if (document.hidden) tally.hiddenMedia = true
        input(mediaInput(action), [action, ...extra].join(' · '))
        // A press pauses the track: keep it going, so the session (and the next press) stays with this page.
        void audio?.play().catch(() => {})
        session.playbackState = 'playing'
      })
      took.push(action)
    } catch { /* not an action here */ }
  }
  session.playbackState = 'playing'
  info(`Headset on · ${took.length} actions taken: ${took.join(' ')}`)
  return true
}
function headsetOff() {
  pausing = true
  audio?.pause()
  pausing = false
  if (!('mediaSession' in navigator)) return
  for (const action of ACTIONS) { try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, null) } catch { /* not an action here */ } }
  navigator.mediaSession.playbackState = 'none'
}
headsetBtn.onclick = async () => {
  if (tally.headset === 'on') { headsetOff(); tally.headset = 'off' }
  else tally.headset = (await headsetOn()) ? 'on' : 'failed'
  renderHeadset()
  changed()
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#track [data-track]')) {
  b.onclick = () => {
    if (!isTrack(b.dataset.track)) return
    useTrack(b.dataset.track)
    void audio?.play().catch(() => {})
    renderHeadset()
    changed()
  }
}

// ---- gamepads ----
interface PadView { el: HTMLElement; name: string; standard: boolean; pressed: boolean[]; dirs: number[]; rumble: string }
const pads = new Map<number, PadView>()
let polling = 0
function padEntry(v: PadView) { return `${v.name} [${v.standard ? 'standard' : 'no mapping'}${v.rumble ? `, ${v.rumble}` : ''}]` }
function notePads() {
  const seen = new Set(tally.pads)
  for (const v of pads.values()) {
    const entry = padEntry(v)
    if (seen.has(entry)) continue
    // One entry per pad: a rumble result replaces the entry without one.
    tally.pads = tally.pads.filter((p) => !p.startsWith(`${v.name} [`))
    tally.pads.push(entry)
  }
  changed()
}
function addPad(gp: Gamepad): PadView {
  const standard = gp.mapping === 'standard'
  const el = document.createElement('article')
  el.className = 'bt-pad glass'
  const name = padName(gp.id)
  const rumbles = !!(gp.vibrationActuator || (gp as Gamepad & { hapticActuators?: unknown[] }).hapticActuators?.length)
  el.innerHTML = `
    <header><span>${GLYPH.pad}</span><div><b>${esc(name)}</b><small>${standard ? 'standard' : 'no mapping'} · ${gp.buttons.length} buttons · ${gp.axes.length} axes · #${gp.index}</small></div>
      ${rumbles ? '<button class="bt-chip" type="button">Rumble</button>' : '<em>no rumble</em>'}</header>
    <div class="bt-pbtns">${gp.buttons.map((_, i) => `<span class="bt-pb"><i></i>${esc(labelOf(padButton(i, standard)))}</span>`).join('')}</div>
    <div class="bt-paxes">${gp.axes.map((_, i) => `<span class="bt-pa"><em>${standard && i < 4 ? ['LX', 'LY', 'RX', 'RY'][i] : `A${i}`}</em><span class="bt-bar"><i></i></span><b>0.00</b></span>`).join('')}</div>`
  $('pads').append(el)
  const v: PadView = { el, name, standard, pressed: gp.buttons.map(() => false), dirs: gp.axes.map(() => 0), rumble: rumbles ? '' : 'no rumble' }
  el.querySelector<HTMLButtonElement>('.bt-chip')?.addEventListener('click', () => void rumble(gp.index, v))
  pads.set(gp.index, v)
  info(`Pad connected: ${gp.id} · mapping "${gp.mapping}"`)
  notePads()
  return v
}
async function rumble(index: number, v: PadView) {
  const gp = navigator.getGamepads?.()[index]
  const act = gp?.vibrationActuator as (GamepadHapticActuator & { effects?: string[] }) | null | undefined
  const legacy = (gp as (Gamepad & { hapticActuators?: { pulse?: (value: number, ms: number) => Promise<boolean> }[] }) | null)?.hapticActuators?.[0]
  let result = 'rumble failed'
  try {
    if (act?.playEffect) {
      const type = act.effects && !act.effects.includes('dual-rumble') && act.effects.includes('trigger-rumble') ? 'trigger-rumble' : 'dual-rumble'
      const r = await act.playEffect(type as GamepadHapticEffectType, { startDelay: 0, duration: 400, weakMagnitude: 0.7, strongMagnitude: 1 })
      result = r === 'complete' ? `rumble ok (${type})` : `rumble ${r}`
    } else if (legacy?.pulse) result = (await legacy.pulse(1, 400)) ? 'rumble ok (pulse)' : 'rumble failed (pulse)'
  } catch (e) { result = `rumble failed (${(e as Error).name || 'error'})` }
  v.rumble = result
  info(result)
  notePads()
}
function poll() {
  polling = 0
  const list = navigator.getGamepads?.() ?? []
  for (const gp of list) {
    if (!gp) continue
    const v = pads.get(gp.index) ?? addPad(gp)
    const btns = v.el.querySelectorAll<HTMLElement>('.bt-pb')
    gp.buttons.forEach((b, i) => {
      btns[i]?.style.setProperty('--v', b.value.toFixed(2))
      if (b.pressed === v.pressed[i]) return
      v.pressed[i] = b.pressed
      btns[i]?.classList.toggle('on', b.pressed)
      if (b.pressed) input(padButton(i, v.standard), `button ${i} · ${b.value.toFixed(2)}`)
    })
    const axes = v.el.querySelectorAll<HTMLElement>('.bt-pa')
    gp.axes.forEach((a, i) => {
      axes[i]?.style.setProperty('--v', a.toFixed(3))
      const out = axes[i]?.querySelector('b')
      if (out) out.textContent = a.toFixed(2)
      // Past 0.6 is a press of that direction; back under 0.3 lets it go.
      const dir = a > 0.6 ? 1 : a < -0.6 ? -1 : Math.abs(a) < 0.3 ? 0 : v.dirs[i]
      if (dir === v.dirs[i]) return
      v.dirs[i] = dir
      if (dir) input(padAxis(i, dir as 1 | -1, v.standard), `axis ${i} · ${a.toFixed(2)}`)
    })
  }
  if (pads.size) polling = requestAnimationFrame(poll)
}
addEventListener('gamepadconnected', (e) => { if (!pads.has(e.gamepad.index)) addPad(e.gamepad); if (!polling) polling = requestAnimationFrame(poll) })
addEventListener('gamepaddisconnected', (e) => {
  const v = pads.get(e.gamepad.index)
  v?.el.remove()
  pads.delete(e.gamepad.index)
  info(`Pad gone: ${e.gamepad.id}`)
})
// Reading the pads from the start (the listeners above count too): until a visible page reads them, Chrome on Android
// gives a pad's buttons to its own shortcuts, where B closes the tab.
try { navigator.getGamepads?.() } catch { /* not allowed here */ }

// ---- the Back button or gesture ----
interface Watcher { onclose: (() => void) | null; destroy(): void }
const Watchers = (window as Window & { CloseWatcher?: new () => Watcher }).CloseWatcher
let watcher: Watcher | null = null
let mark: { obpalBack: number } | null = null
/** Whether the history entry now armed came from a tap. */
let markTapped = false
const backBtn = $('back')
/** Arms one catch. `tapped`: from the person's tap (a user activation), or re-armed after a catch without one. */
function armBack(tapped: boolean) {
  if (Watchers) {
    watcher = new Watchers()
    watcher.onclose = () => { watcher = null; caught('closewatcher', tapped) }
  } else {
    mark = { obpalBack: Date.now() }
    markTapped = tapped
    history.pushState(mark, '')
  }
}
function disarmBack() {
  watcher?.destroy()
  watcher = null
  if (mark && history.state === mark) history.back()
  mark = null
}
function caught(via: string, tapped: boolean) {
  tally.back.caught++
  tally.back.via = via
  input('back', `${via} · armed ${tapped ? 'by a tap' : 'again, no tap'}`)
  if (tally.back.on) armBack(false)
}
addEventListener('popstate', () => {
  if (!mark || history.state === mark) return
  mark = null
  if (tally.back.on) caught('history', markTapped)
})
backBtn.onclick = () => {
  tally.back.on = !tally.back.on
  if (tally.back.on) armBack(true)
  else disarmBack()
  backBtn.setAttribute('aria-pressed', String(tally.back.on))
  changed()
}

// ---- fullscreen, the page hidden, clearing ----
const fsBtn = $('fs')
fsBtn.hidden = !document.fullscreenEnabled
fsBtn.onclick = () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => info('Fullscreen refused'))
}
document.addEventListener('fullscreenchange', () => {
  fsBtn.setAttribute('aria-pressed', String(!!document.fullscreenElement))
  info(document.fullscreenElement ? 'Fullscreen on' : 'Fullscreen off')
})
document.addEventListener('visibilitychange', () => info(document.hidden ? 'Page hidden' : 'Page visible'))
$('clear').onclick = () => {
  const keep = { env: tally.env, headset: tally.headset, track: tally.track, hold: tally.volume.hold, back: tally.back.on }
  tally = { ...emptyTally(keep.env), headset: keep.headset, track: keep.track, volume: { hold: keep.hold }, back: { on: keep.back, caught: 0, via: '' } }
  rows = []
  for (const v of pads.values()) v.rumble = v.rumble === 'no rumble' ? v.rumble : ''
  notePads()
  renderLog()
  $('last').textContent = 'Press'
  $('sub').textContent = 'volume · headset · remote · pad · back'
  delete heroEl.dataset.src
}

// ---- the summary to paste back ----
const copyBtn = $<HTMLButtonElement>('copy')
function flash(b: HTMLButtonElement, text: string) {
  const was = b.dataset.label ?? b.textContent ?? ''
  b.dataset.label = was
  b.textContent = text
  setTimeout(() => { b.textContent = was }, 1400)
}
copyBtn.onclick = async () => {
  const text = summarize(tally)
  try {
    await navigator.clipboard.writeText(text)
    flash(copyBtn, 'Copied')
  } catch {
    // No clipboard here: select it, for the phone's own Copy.
    const range = document.createRange()
    range.selectNodeContents($('sum'))
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    flash(copyBtn, 'Selected')
  }
}
const shareBtn = $<HTMLButtonElement>('share')
shareBtn.hidden = !navigator.share
shareBtn.onclick = () => { void navigator.share?.({ text: summarize(tally) }).catch(() => {}) }

renderHold()
renderHeadset()
renderLog()
changed()
/** For the e2e check (scripts/e2e-phone.mjs) and for poking at from a console. */
;(window as Window & { __buttons?: unknown }).__buttons = { tally: () => tally, summary: () => summarize(tally) }
