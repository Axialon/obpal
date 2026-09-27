/**
 * Options page: PC control. Whole-PC mode on or off, a global Pause, and every allowed program with its scope
 * (keyboard / mouse) and remove; the phones asked about and whether each may control this PC (spec/SECURITY.md §8,
 * L1), with a notification for the next one if you like; ob.Pal Desktop's version and panic key; and the look
 * (../ui/look.ts), as in the popup. A phone's question for the PC shows here too, on top (its notification opens this
 * page). It renders from storage (the helper's state, mirrored into storage.session "pc" by the service worker, and
 * the answers) and asks the worker to change things; the helper is the one that persists its own.
 */
import '../../../src/family'
import '../../../src/styles/base.css'
import '../ui/link.css'
import './options.css'
import { ICONS, LOGO_WORD } from '../../../src/ui/icons'
import { askFor, parseAnswers, parsePhone, type Answers, type Phone } from '../shared/access'
import { DEFAULT_MODE, isTargetMode, type TargetMode } from '../shared/constants'
import { DESKTOP_URL, EMPTY_PC, parsePcState, PC_PAGE_PORT_NAME, type PcProgramEntry, type PcState } from '../shared/native'
import { parseLink, type BgRequest } from '../shared/messages'
import { LINK_ICONS } from '../popup/icons'
import { askCard, showAsk } from '../ui/ask'
import { lightCards, mountLogo, mountLook, settle, startLook } from '../ui/look'

startLook()

const NATIVE_PERMISSION: chrome.permissions.Permissions = { permissions: ['nativeMessaging'] }
const NOTIFY: chrome.permissions.Permissions = { permissions: ['notifications'] }
const LINK_PAGE = 'https://obpal.blackboxes.net/link/'
const PRIVACY = 'https://obpal.blackboxes.net/privacy/'
const app = document.getElementById('app') as HTMLElement
let pc: PcState = { ...EMPTY_PC }
let permission = false
/** What the question for the PC, and the phones' list, are made of. */
let mode: TargetMode = DEFAULT_MODE
let phone: Phone | null = null
let linked = false
let answers: Answers = {}
let notify = false

app.innerHTML = `
  <header class="top rise">
    <span class="logo" aria-label="ob.Pal"><span class="mark-slot" data-mark></span>${LOGO_WORD}</span>
    <span class="tag">Link</span>
    <span class="ver" id="ver"></span>
  </header>
  <section class="hero rise" style="--i:1" aria-labelledby="title">
    <p class="kicker">${LINK_ICONS.pc}<span>ob.Pal Desktop · Windows</span></p>
    <h1 id="title" tabindex="-1">PC control</h1>
    <p class="lede">Your phone as this computer’s mouse and keyboard: in every window, or only in the programs you allow.</p>
    <div class="helper" id="helper" hidden>
      <span class="helper-ver" id="helper-ver"></span>
      <span class="helper-panic" id="helper-panic" title="The panic key stops everything at once"></span>
    </div>
  </section>
  <p class="note swap" id="note" role="alert" hidden></p>
  <div class="layout">
    <div class="col">
      <section class="card switches rise" style="--i:2" aria-label="All programs">
        <button class="row big" id="whole" type="button" role="switch" aria-checked="false" title="The phone is this PC's mouse and keyboard in every window, not only the programs below">
          <span class="row-ic">${LINK_ICONS.pc}</span>
          <span class="row-t"><b>Whole PC</b><small id="whole-t">Every window, not only the programs below</small></span>
          <span class="sw" aria-hidden="true"><i></i></span>
        </button>
        <button class="row big pause" id="pause" type="button" role="switch" aria-checked="false" title="Stop all keyboard and mouse input from the phone">
          <span class="row-ic">${LINK_ICONS.pause}</span>
          <span class="row-t"><b>Pause all</b><small>Nothing reaches any program while paused</small></span>
          <span class="sw" aria-hidden="true"><i></i></span>
        </button>
        <p class="scope" id="foot"></p>
      </section>
      <section class="card programs rise" style="--i:3" aria-labelledby="list-h">
        <header class="card-h"><h2 id="list-h">Allowed programs</h2><span class="count" id="count" hidden></span></header>
        <div class="list" id="list"></div>
        <div class="empty swap" id="empty" hidden><span class="empty-art">${LINK_ICONS.pc}</span><b>No programs allowed</b><span>Switch to a program, open ob.Pal Link and choose PC to allow it.</span></div>
      </section>
      <section class="card phones rise" style="--i:4" aria-labelledby="phones-h">
        <header class="card-h"><h2 id="phones-h">Phones</h2><span class="count" id="phones-n" hidden></span></header>
        <p class="card-say">A phone controls this PC only once you allow it. Link asks the first time it picks PC.</p>
        <div class="list" id="phones" role="group" aria-labelledby="phones-h"></div>
        <div class="empty swap" id="phones-empty" hidden><span class="empty-art">${ICONS.phone}</span><b>No phone has asked yet</b><span>Your answer for each phone shows here, and you can change it.</span></div>
        <button class="row notify" id="notify" type="button" role="switch" aria-checked="false" title="A notification with Allow and Deny when a phone asks for this PC and Link's popup is closed">
          <span class="row-ic">${LINK_ICONS.bell}</span>
          <span class="row-t"><b>Notify me</b><small>When a phone asks for this PC and the popup is closed</small></span>
          <span class="sw" aria-hidden="true"><i></i></span>
        </button>
      </section>
    </div>
    <aside class="col side">
      <section class="card look-card rise" style="--i:3" aria-labelledby="look-h">
        <header class="card-h"><h2 id="look-h">Look</h2>${ICONS.palette}</header>
        <div id="look"></div>
      </section>
      <section class="card about rise" style="--i:4" aria-label="About">
        <a class="link-row" href="${DESKTOP_URL}" target="_blank" rel="noopener">${LINK_ICONS.pc}<span>Get ob.Pal Desktop</span>${ICONS.open}</a>
        <a class="link-row" href="${LINK_PAGE}" target="_blank" rel="noopener">${ICONS.phone}<span>ob.Pal Link on the web</span>${ICONS.open}</a>
        <a class="link-row" href="${PRIVACY}" target="_blank" rel="noopener">${LINK_ICONS.shield}<span>Privacy</span>${ICONS.open}</a>
      </section>
    </aside>
  </div>`

mountLogo(app, 2)
lightCards()
mountLook(document.getElementById('look') as HTMLElement)
document.getElementById('ver')!.textContent = `v${chrome.runtime.getManifest().version}`

const $ = (id: string) => document.getElementById(id) as HTMLElement
const send = (m: BgRequest): Promise<unknown> => chrome.runtime.sendMessage(m).catch((e: unknown) => ({ ok: false, error: String(e) }))
// A phone's question for the PC, right under the heading (the notification about it opens this page).
const askEl = askCard((key, allow) => void send({ to: 'bg', type: 'answer', key, allow }))
app.insertBefore(askEl, $('note'))

/**
 * The phones asked about, newest answer first, each a switch: allowed to control this PC, or not. A change goes to the
 * service worker, which keeps it (and arms or disarms ob.Pal Desktop if that phone is connected).
 */
function renderPhones() {
  const list = $('phones')
  const rows = Object.entries(answers).sort((a, b) => b[1].at - a[1].at)
  list.replaceChildren(...rows.map(([key, a]) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'row phone-row'
    row.setAttribute('role', 'switch')
    row.setAttribute('aria-checked', String(a.allow))
    row.innerHTML = `<span class="row-ic">${ICONS.phone}</span><span class="row-t"><b></b><small></small></span><span class="sw" aria-hidden="true"><i></i></span>`
    row.querySelector('b')!.textContent = a.name
    row.querySelector('small')!.textContent = `${a.allow ? 'Can control this PC' : 'Can’t control this PC'}${phone?.key === key && linked ? ' · connected' : ''}`
    row.title = a.allow ? `Stop ${a.name} controlling this PC` : `Let ${a.name} control this PC`
    row.onclick = () => void send({ to: 'bg', type: 'answer', key, allow: !a.allow })
    return row
  }))
  $('phones-empty').hidden = rows.length > 0
  $('phones-n').hidden = !rows.length
  $('phones-n').textContent = String(rows.length)
  const n = $('notify')
  n.setAttribute('aria-checked', String(notify))
}

// A notification for the next question: the optional permission, asked for (or given back) in the click.
$('notify').addEventListener('click', () => {
  const done = (on: boolean) => { notify = on; renderPhones() }
  if (notify) chrome.permissions.remove(NOTIFY).then((gone) => done(!gone), () => renderPhones())
  else chrome.permissions.request(NOTIFY).then(done, () => renderPhones())
})

/** A program's badge: its initial on a tint of its own, so the list reads at a glance. */
const TINTS = ['56 189 248', '251 113 133', '252 211 77', '110 231 183', '210 195 246', '153 225 217']
function tintOf(name: string) {
  let h = 0
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return TINTS[h % TINTS.length]
}

/**
 * The allowed programs, one row each, kept by path: a change of scope updates its row in place (so its toggles move
 * rather than the row being rebuilt), a new program eases in, a removed one leaves.
 */
const rows = new Map<string, { el: HTMLElement; p: PcProgramEntry }>()

function programRow(p: PcProgramEntry): HTMLElement {
  const row = document.createElement('div')
  row.className = 'prog swap'
  row.innerHTML = `
    <span class="prog-ic" aria-hidden="true"></span>
    <span class="row-t"><b></b><small></small></span>
    <span class="kinds" role="group" aria-label="Allowed input">
      <button class="kind" type="button" data-kind="keyboard" aria-pressed="false" title="Keyboard">${LINK_ICONS.keys}<span>keys</span></button>
      <button class="kind" type="button" data-kind="mouse" aria-pressed="false" title="Mouse">${LINK_ICONS.mouse}<span>mouse</span></button>
    </span>
    <button class="icon-btn forget" type="button" data-act="forget" title="Remove" aria-label="Stop allowing this program">${ICONS.close}</button>`
  const badge = row.querySelector<HTMLElement>('.prog-ic')!
  badge.textContent = (p.name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
  badge.style.setProperty('--tint', tintOf(p.name))
  row.querySelector('b')!.textContent = p.name
  row.querySelector('small')!.textContent = p.path
  row.title = p.path
  const path = p.path
  for (const b of row.querySelectorAll<HTMLButtonElement>('.kind')) {
    b.addEventListener('click', () => {
      const cur = rows.get(path)?.p
      if (!cur) return
      const next = { keyboard: cur.keyboard, mouse: cur.mouse }
      next[b.dataset.kind as 'keyboard' | 'mouse'] = b.getAttribute('aria-pressed') !== 'true'
      void send({ to: 'bg', type: 'pc-scope', path, ...next })
    })
  }
  row.querySelector<HTMLButtonElement>('[data-act=forget]')!.addEventListener('click', () => void send({ to: 'bg', type: 'pc-forget', path }))
  return row
}

function renderList(programs: PcProgramEntry[]) {
  const list = $('list')
  const keep = new Set(programs.map((p) => p.path))
  for (const [path, r] of rows) if (!keep.has(path)) { r.el.remove(); rows.delete(path) }
  programs.forEach((p, i) => {
    let r = rows.get(p.path)
    if (!r) rows.set(p.path, (r = { el: programRow(p), p }))
    r.p = p
    for (const b of r.el.querySelectorAll<HTMLElement>('.kind')) b.setAttribute('aria-pressed', String(p[b.dataset.kind as 'keyboard' | 'mouse']))
    if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] ?? null)
  })
  $('empty').hidden = programs.length > 0
  $('count').hidden = !programs.length
  $('count').textContent = String(programs.length)
}

function render() {
  const ready = pc.link === 'ready'
  const pause = $('pause') as HTMLButtonElement
  pause.setAttribute('aria-checked', String(!!pc.config?.paused))
  pause.disabled = !ready
  const whole = $('whole') as HTMLButtonElement
  const desktop = !!pc.config?.desktop && (pc.config.desktop.keyboard || pc.config.desktop.mouse)
  whole.setAttribute('aria-checked', String(desktop))
  whole.disabled = !ready || !pc.desktopCap
  $('whole-t').textContent = ready && !pc.desktopCap ? 'Needs ob.Pal Desktop 0.2 or later' : 'Every window, not only the programs below'

  // ob.Pal Desktop, once it answers: its version and the panic key.
  $('helper').hidden = !ready
  $('helper-ver').textContent = `ob.Pal Desktop ${pc.version ?? ''}`.trim()
  const panic = $('helper-panic')
  panic.replaceChildren()
  if (pc.hotkey) {
    const label = document.createElement('span')
    label.textContent = 'Panic key'
    panic.append(label)
    for (const k of pc.hotkey.split('+')) {
      const key = document.createElement('kbd')
      key.textContent = k
      panic.append(key)
    }
  } else {
    panic.textContent = 'No panic key (the combination is taken)'
  }

  renderList(pc.config?.programs ?? [])
  renderPhones()
  showAsk(askEl, askFor(mode, linked ? phone : null, answers, permission), () => $('title').focus())

  const note = $('note')
  const notice = noticeFor()
  note.hidden = !notice
  note.replaceChildren()
  if (notice) {
    note.insertAdjacentHTML('afterbegin', LINK_ICONS.info)
    const t = document.createElement('span')
    t.textContent = notice.text
    note.append(t)
    if (notice.action) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = notice.action.label
      b.onclick = notice.action.run
      note.append(b)
    }
  }

  const foot = $('foot')
  foot.hidden = !ready
  foot.textContent = desktop
    ? 'Every window receives input, except those running as administrator: Windows keeps them out of reach.'
    : 'Only the program in front receives input, and only the kinds allowed here.'
}

function noticeFor(): { text: string; action?: { label: string; run: () => void } } | null {
  switch (pc.link) {
    case 'ready':
      return null
    case 'permission':
      return permission ? null : { text: 'PC control is off.', action: { label: 'Turn on', run: requestPermission } }
    case 'missing':
      return { text: 'ob.Pal Desktop isn’t installed.', action: { label: 'How to install', run: () => void chrome.tabs.create({ url: DESKTOP_URL }) } }
    case 'error':
      return { text: pc.error ?? 'The helper stopped.', action: { label: 'Retry', run: () => void send({ to: 'bg', type: 'pc-connect' }) } }
    default:
      return { text: 'Starting ob.Pal Desktop…' }
  }
}

// permissions.request() must run inside the click, before anything is awaited.
function requestPermission() {
  chrome.permissions.request(NATIVE_PERMISSION).then((granted) => {
    permission = granted
    if (granted) chrome.runtime.connect({ name: PC_PAGE_PORT_NAME })
    render()
  }, () => render())
}

$('pause').addEventListener('click', () => void send({ to: 'bg', type: 'pc-pause', on: !pc.config?.paused }))
$('whole').addEventListener('click', () => void send({ to: 'bg', type: 'pc-desktop', on: !pc.config?.desktop, keyboard: true, mouse: true }))

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') {
    if (changes.pc) pc = parsePcState(changes.pc.newValue) ?? { ...EMPTY_PC }
    if (changes.phone) phone = parsePhone(changes.phone.newValue)
    if (changes.link) linked = parseLink(changes.link.newValue)?.status === 'connected'
  } else if (area === 'local') {
    if (changes.mode && isTargetMode(changes.mode.newValue)) mode = changes.mode.newValue
    if (changes.answers) answers = parseAnswers(changes.answers.newValue)
  }
  render()
})
chrome.permissions.onAdded.addListener(() => void refreshPermissions())
chrome.permissions.onRemoved.addListener(() => void refreshPermissions())

async function refreshPermissions() {
  ;[permission, notify] = await Promise.all([chrome.permissions.contains(NATIVE_PERMISSION), chrome.permissions.contains(NOTIFY)])
  render()
}

async function init() {
  const [session, local, granted, notes] = await Promise.all([
    chrome.storage.session.get(['pc', 'phone', 'link']), chrome.storage.local.get(['mode', 'answers']),
    chrome.permissions.contains(NATIVE_PERMISSION), chrome.permissions.contains(NOTIFY),
  ])
  pc = parsePcState(session.pc) ?? { ...EMPTY_PC }
  phone = parsePhone(session.phone)
  linked = parseLink(session.link)?.status === 'connected'
  mode = isTargetMode(local.mode) ? local.mode : DEFAULT_MODE
  answers = parseAnswers(local.answers)
  permission = granted
  notify = notes
  render()
  settle()
  // Holding this port keeps the helper up while the page is open (it closes with the page).
  if (granted) chrome.runtime.connect({ name: PC_PAGE_PORT_NAME })
}

void init()
