/**
 * The control catalogue page (/catalogue/): the utilities, profiles, control systems and bridges, from the same data
 * the phone and hosts use, and a builder for a new controller profile, checked with checkProfile() as the build is.
 */
import { applyTheme, initialTheme } from '../ui/themes'
import { calmMarks, mountMarks } from '../ui/icons'
import { mountTopBar } from '../landing/topbar'
import { checkProfile, MOTION_UTILITIES, PROFILE_IDS, PROFILE_LIMITS, PROFILES, ROUTES, utilityKey, type MotionUtility, type ProfileSpec } from '@obpal/core'
import { BRIDGE_ROWS, proposeUrl, SYSTEM_ROWS, UTILITY_ROWS, type CatalogueRow } from './data'

applyTheme(initialTheme())
mountMarks()
calmMarks(document, 2)
mountTopBar()

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const NAMES: Record<MotionUtility, string> = { 'motion.aim': 'Aim', 'motion.steer': 'Steer', 'motion.point': 'Point' }

/** Community profiles (catalogue/profiles/*.json), checked when built. */
const community = Object.values(import.meta.glob<ProfileSpec>('../../catalogue/profiles/*.json', { eager: true, import: 'default' }))

function rows(id: string, list: CatalogueRow[]) {
  $(id).innerHTML = list.map((r) => `
    <article class="cat-card">
      <header><b>${esc(r.name)}</b><span class="st ${r.status === 'Planned' ? 'plan' : ''}">${r.status}</span></header>
      <code>${esc(r.id)}</code>
      <p>${esc(r.what)}</p>
      ${r.link ? `<a href="${r.link}">Try it →</a>` : ''}
    </article>`).join('')
}
rows('utilities', UTILITY_ROWS)
rows('systems', SYSTEM_ROWS)
rows('bridges', BRIDGE_ROWS)

const routeLine = (p: ProfileSpec) => MOTION_UTILITIES.map((u) => `<span><i>${NAMES[u]}</i>${p[utilityKey(u)].route}</span>`).join('')
$('profiles').innerHTML = [...PROFILE_IDS.map((id) => ({ p: PROFILES[id] as ProfileSpec, from: 'Built in' })), ...community.map((p) => ({ p, from: 'Community' }))]
  .map(({ p, from }) => `
    <article class="cat-card">
      <header><b>${esc(p.name)}</b><span class="st ${from === 'Community' ? 'com' : ''}">${from}</span></header>
      <code>${esc(p.id)}</code>
      <p>${esc(p.for)}</p>
      <div class="routes">${routeLine(p)}</div>
    </article>`).join('')

// ---- the builder ----

const fmt = (n: number) => (Math.abs(n) >= 10 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(2).replace(/0$/, '') : n.toFixed(2))
const base = $<HTMLSelectElement>('base')
for (const id of PROFILE_IDS) base.add(new Option(PROFILES[id].name, id))
for (const p of community) base.add(new Option(`${p.name} (community)`, `c:${p.id}`))

$('on').innerHTML = MOTION_UTILITIES.map((u) => `<label class="chk"><input type="checkbox" value="${u}"> ${NAMES[u]}</label>`).join('')
$('utils').innerHTML = MOTION_UTILITIES.map((u) => {
  const key = utilityKey(u)
  const range = (name: 'gain' | 'curve' | 'deadzone', step: number) => {
    const [lo, hi] = PROFILE_LIMITS[name]
    return `<label class="rng"><span>${{ gain: 'Sensitivity', curve: 'Curve', deadzone: 'Deadzone jump' }[name]}</span><input type="range" name="${name}" min="${lo}" max="${hi}" step="${step}"><output></output></label>`
  }
  return `
    <fieldset class="bld-u" data-key="${key}">
      <legend>${NAMES[u]} <code>${u}</code></legend>
      <label class="fld"><span>Goes to</span><select name="route">${ROUTES[u].map((r) => `<option>${r}</option>`).join('')}</select></label>
      ${range('gain', 0.05)}${range('curve', 0.05)}${range('deadzone', 0.01)}
      <label class="chk"><input type="checkbox" name="invertY"> Invert up and down</label>
      ${u === 'motion.point' ? '<label class="chk"><input type="checkbox" name="edgeTurn"> Turn at the screen’s edge</label>' : '<input type="checkbox" name="edgeTurn" hidden>'}
    </fieldset>`
}).join('')

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
  return {
    id: $<HTMLInputElement>('pid').value.trim(),
    name: $<HTMLInputElement>('pname').value.trim(),
    for: $<HTMLInputElement>('pfor').value.trim(),
    on: [...$('on').querySelectorAll<HTMLInputElement>('input:checked')].map((b) => b.value),
    ...settings,
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
  $('errs').innerHTML = errors.map((e) => `<li>${esc(e)}</li>`).join('')
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
