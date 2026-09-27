/**
 * The control catalogue page (/catalogue/): the utilities, profiles, control systems and bridges, from the same data
 * the phone and hosts use, and a builder for a new controller profile, checked with checkProfile() as the build is.
 */import { type Content, setMarkup, html } from '../ui/markup'

import { applyTheme, initialTheme } from '../ui/themes'
import { calmMarks, mountMarks } from '../ui/icons'
import { mountTopBar } from '../landing/topbar'
import {
  APP_ACTIONS, checkProfile, Controller, CONTROLLER_IDS, CONTROLLERS, INPUT_OPTIONS, isControllerId, KEY_TARGETS, MOTION_UTILITIES, optionOf,
  PROFILE_IDS, PROFILE_LIMITS, PROFILES, ROUTES, targetLabel, utilityKey, type ControllerId, type InputSource, type MotionUtility, type ProfileSpec,
} from '@obpal/core'
import { BRIDGE_ROWS, proposeUrl, SYSTEM_ROWS, UTILITY_ROWS, type CatalogueRow } from './data'

applyTheme(initialTheme())
mountMarks()
calmMarks(document, 2)
mountTopBar()

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const NAMES: Record<MotionUtility, string> = { 'motion.aim': 'Aim', 'motion.steer': 'Steer', 'motion.point': 'Point' }

/** Community profiles (catalogue/profiles/*.json), checked when built. */
const community = Object.values(import.meta.glob<ProfileSpec>('../../catalogue/profiles/*.json', { eager: true, import: 'default' }))

function rows(id: string, list: CatalogueRow[]) {
  setMarkup($(id), list.map((r) => html`
    <article class="cat-card">
      <header><b>${r.name}</b><span class="st ${r.status === 'Planned' ? 'plan' : ''}">${r.status}</span></header>
      <code>${r.id}</code>
      <p>${r.what}</p>
      ${r.link ? html`<a href="${r.link}">Try it →</a>` : ''}
    </article>`))
}
// Controllers: what a person picks on the phone, each built from utilities (CATALOGUE §9.1), and the sims that take it.
setMarkup($('controllers'), CONTROLLER_IDS.map((id) => CONTROLLERS[id]).map((c) => html`
    <article class="cat-card">
      <header><b>${c.name}</b><span class="st">${c.category}</span></header>
      <code>${c.id}</code>
      <p>${c.for}</p>
      ${c.utilities.length ? html`<div class="routes">${c.utilities.map((u) => html`<span>${u}</span>`)}</div>` : ''}
      <a href="/sim/?face=${c.id.slice(5)}">Try it in a sim →</a>
    </article>`))
rows('utilities', UTILITY_ROWS)
rows('systems', SYSTEM_ROWS)
rows('bridges', BRIDGE_ROWS)

const routeLine = (p: ProfileSpec) => MOTION_UTILITIES.map((u) => html`<span><i>${NAMES[u]}</i>${p[utilityKey(u)].route}</span>`)
setMarkup($('profiles'), [...PROFILE_IDS.map((id) => ({ p: PROFILES[id] as ProfileSpec, from: 'Built in' })), ...community.map((p) => ({ p, from: 'Community' }))]
  .map(({ p, from }) => html`
    <article class="cat-card">
      <header><b>${p.name}</b><span class="st ${from === 'Community' ? 'com' : ''}">${from}</span></header>
      <code>${p.id}</code>
      <p>${p.for}</p>
      <div class="routes">${routeLine(p)}</div>
    </article>`))

// ---- the builder ----

const fmt = (n: number) => (Math.abs(n) >= 10 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(2).replace(/0$/, '') : n.toFixed(2))
const base = $<HTMLSelectElement>('base')
for (const id of PROFILE_IDS) base.add(new Option(PROFILES[id].name, id))
for (const p of community) base.add(new Option(`${p.name} (community)`, `c:${p.id}`))

setMarkup($('on'), MOTION_UTILITIES.map((u) => html`<label class="chk"><input type="checkbox" value="${u}"> ${NAMES[u]}</label>`))
setMarkup($('utils'), MOTION_UTILITIES.map((u) => {
  const key = utilityKey(u)
  const range = (name: 'gain' | 'curve' | 'deadzone', step: number) => {
    const [lo, hi] = PROFILE_LIMITS[name]
    return html`<label class="rng"><span>${{ gain: 'Sensitivity', curve: 'Curve', deadzone: 'Deadzone jump' }[name]}</span><input class="bb-range" type="range" name="${name}" min="${lo}" max="${hi}" step="${step}"><output></output></label>`
  }
  return html`
    <fieldset class="bld-u" data-key="${key}">
      <legend>${NAMES[u]} <code>${u}</code></legend>
      <label class="fld"><span>Goes to</span><select name="route">${ROUTES[u].map((r) => html`<option>${r}</option>`)}</select></label>
      ${range('gain', 0.05)}${range('curve', 0.05)}${range('deadzone', 0.01)}
      <label class="chk"><input type="checkbox" name="invertY"> Invert up and down</label>
      ${u === 'motion.point' ? html`<label class="chk"><input type="checkbox" name="edgeTurn"> Turn at the screen’s edge</label>` : html`<input type="checkbox" name="edgeTurn" hidden>`}
    </fieldset>`
}))

// ---- the builder's buttons: what a phone's keys, headset, pad or Back press, where it differs from the controller's own ----

const SOURCE_NAME: Record<InputSource, string> = { media: 'Headset', keys: 'Keys', pad: 'Pad', back: 'Back', volume: 'A keyboard’s volume keys' }
const bctl = $<HTMLSelectElement>('bctl')
for (const id of CONTROLLER_IDS) bctl.add(new Option(CONTROLLERS[id].name, id))
const inputSelect = () => html`<select class="bin" aria-label="Press">${INPUT_OPTIONS.map((g) => html`<optgroup label="${SOURCE_NAME[g.source]}">${g.ids.map((id) => html`<option value="${id}">${optionOf(id)}</option>`)}</optgroup>`)}</select>`
/** What an input can press on the chosen controller: its controls, a key on the screen, the phone's own, a tray button, or nothing. */
function targetOptions(c: ControllerId): Content {
  const opt = (t: string) => html`<option value="${t}">${targetLabel(c, t)}</option>`
  return html`${html`<optgroup label="${CONTROLLERS[c].name}">${CONTROLLERS[c].controls.map(opt)}</optgroup>`}${(c === Controller.keyboard ? '' : html`<optgroup label="Keys on the screen">${KEY_TARGETS.map((t) => html`<option value="${t}">Key ${targetLabel(c, t)}</option>`)}</optgroup>`)}${html`<optgroup label="On the phone">${APP_ACTIONS.map((a) => opt(`app:${a}`))}</optgroup>`}${html`<optgroup label="Other"><option value="tray:">A tray button…</option><option value="none">Nothing (takes it away)</option></optgroup>`}`
}
function addRow(input?: string, target?: string) {
  const row = document.createElement('div')
  row.className = 'brow'
  setMarkup(row, html`${html`${inputSelect()}<span aria-hidden="true">→</span><select class="bto" aria-label="Does">${targetOptions(bctl.value as ControllerId)}</select>`}${html`<input class="btray" placeholder="tray id" spellcheck="false" aria-label="Tray button id" hidden><button class="bdel" type="button" aria-label="Remove">×</button>`}`)
  const bin = row.querySelector<HTMLSelectElement>('.bin')!
  const bto = row.querySelector<HTMLSelectElement>('.bto')!
  const tray = row.querySelector<HTMLInputElement>('.btray')!
  if (input) bin.value = input
  if (target?.startsWith('tray:')) { bto.value = 'tray:'; tray.value = target.slice(5) } else if (target) bto.value = target
  tray.hidden = bto.value !== 'tray:'
  bto.addEventListener('change', () => { tray.hidden = bto.value !== 'tray:'; if (!tray.hidden) tray.focus() })
  row.querySelector<HTMLButtonElement>('.bdel')!.onclick = () => { row.remove(); update() }
  $('brows').appendChild(row)
}
function readButtons(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of $('brows').querySelectorAll<HTMLElement>('.brow')) {
    const input = row.querySelector<HTMLSelectElement>('.bin')!.value
    const to = row.querySelector<HTMLSelectElement>('.bto')!.value
    out[input] = to === 'tray:' ? `tray:${row.querySelector<HTMLInputElement>('.btray')!.value.trim()}` : to
  }
  return out
}
bctl.addEventListener('change', () => {
  // The same bindings, offered what this controller can press (one it can't shows as the checker's error).
  const kept = readButtons()
  $('brows').replaceChildren()
  for (const [input, t] of Object.entries(kept)) addRow(input, t)
  update()
})
$('badd').addEventListener('click', () => { addRow(); update() })

/** Fill the form from a built-in (or community) profile, keeping what the person already named. */
function load(p: ProfileSpec) {
  for (const box of $('on').querySelectorAll<HTMLInputElement>('input')) box.checked = (p.on as readonly string[]).includes(box.value)
  for (const fs of $('utils').querySelectorAll<HTMLFieldSetElement>('.bld-u')) {
    const s = p[fs.dataset.key as 'aim' | 'steer' | 'point']
    ;(fs.querySelector('[name=route]') as HTMLSelectElement).value = s.route
    for (const n of ['gain', 'curve', 'deadzone'] as const) (fs.querySelector(`[name=${n}]`) as HTMLInputElement).value = String(s[n])
    ;(fs.querySelector('[name=invertY]') as HTMLInputElement).checked = s.invertY
    ;(fs.querySelector('[name=edgeTurn]') as HTMLInputElement).checked = s.edgeTurn
  }
  if (!$<HTMLInputElement>('pfor').value) $<HTMLInputElement>('pfor').placeholder = p.for
  bctl.value = p.controller && isControllerId(p.controller) ? p.controller : Controller.gamepad
  $('brows').replaceChildren()
  for (const [input, t] of Object.entries(p.buttons ?? {})) addRow(input, t)
  update()
}

function read(): unknown {
  const settings = Object.fromEntries([...$('utils').querySelectorAll<HTMLFieldSetElement>('.bld-u')].map((fs) => {
    const v = (n: string) => fs.querySelector<HTMLInputElement>(`[name=${n}]`)!
    return [fs.dataset.key, {
      route: v('route').value,
      gain: Number(v('gain').value), curve: Number(v('curve').value), deadzone: Number(v('deadzone').value),
      invertY: v('invertY').checked, edgeTurn: v('edgeTurn').checked,
    }]
  }))
  const buttons = readButtons()
  return {
    id: $<HTMLInputElement>('pid').value.trim(),
    name: $<HTMLInputElement>('pname').value.trim(),
    for: $<HTMLInputElement>('pfor').value.trim(),
    on: [...$('on').querySelectorAll<HTMLInputElement>('input:checked')].map((b) => b.value),
    ...settings,
    ...(bctl.value !== Controller.gamepad ? { controller: bctl.value } : {}),
    ...(Object.keys(buttons).length ? { buttons } : {}),
  }
}

let json = ''
function update() {
  for (const out of $('utils').querySelectorAll<HTMLOutputElement>('output')) {
    const input = out.previousElementSibling as HTMLInputElement
    out.textContent = input.name === 'deadzone' ? fmt(Number(input.value)) : `${fmt(Number(input.value))}×`
  }
  const draft = read()
  const { profile, errors } = checkProfile(draft)
  json = JSON.stringify(profile ?? draft, null, 2)
  $('json').textContent = json
  setMarkup($('errs'), errors.map((e) => html`<li>${e}</li>`))
  const ok = !!profile
  const propose = $<HTMLAnchorElement>('propose')
  propose.classList.toggle('off', !ok)
  propose.setAttribute('aria-disabled', String(!ok))
  if (ok) propose.href = proposeUrl(profile.name, json)
  else propose.removeAttribute('href')
  $<HTMLButtonElement>('save').disabled = !ok
}

$('bld').addEventListener('input', update)
base.addEventListener('change', () => {
  const v = base.value
  load(v.startsWith('c:') ? community.find((p) => `c:${p.id}` === v)! : (PROFILES[v as keyof typeof PROFILES] as ProfileSpec))
})
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(json); $('copy').textContent = 'Copied' } catch { $('copy').textContent = 'Select and copy it' }
  setTimeout(() => { $('copy').textContent = 'Copy' }, 1600)
})
$('save').addEventListener('click', () => {
  const { profile } = checkProfile(read())
  if (!profile) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([`${json}\n`], { type: 'application/json' }))
  a.download = `${profile.id}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})
load(PROFILES.default as ProfileSpec)
