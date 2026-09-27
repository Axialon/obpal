/**
 * Options page: PC control. Whole-PC mode on or off, every allowed program with its scope (keyboard / mouse),
 * remove, and a global Pause. It renders from storage.session "pc" (mirrored there by the service worker from the helper)
 * and asks the worker to change things; the helper is the one that persists them.
 */
import { family } from '../../../src/family'
import '../../../src/styles/base.css'
import './options.css'
import { ICONS, logo } from '../../../src/ui/icons'
import { EMPTY_PC, parsePcState, PC_PAGE_PORT_NAME, type PcProgramEntry, type PcState } from '../shared/native'
import type { BgRequest } from '../shared/messages'
import { LINK_ICONS } from '../popup/icons'

family.setProduct('obpal')

const NATIVE_PERMISSION: chrome.permissions.Permissions = { permissions: ['nativeMessaging'] }
const app = document.getElementById('app') as HTMLElement
let pc: PcState = { ...EMPTY_PC }
let permission = false

app.innerHTML = `
  <header class="bar">
    <span class="logo" aria-label="ob.Pal">${logo()}</span>
    <span class="tag">Link</span>
    <h1>PC control</h1>
  </header>
  <section class="panel glass" aria-label="All programs">
    <button class="row" id="whole" type="button" role="switch" aria-checked="false" title="The phone is this PC's mouse and keyboard in every window, not only the programs below">
      <span class="row-ic">${LINK_ICONS.pc}</span>
      <span class="row-t"><b>Whole PC</b><small id="whole-t">Every window, not only the programs below</small></span>
      <span class="sw" aria-hidden="true"><i></i></span>
    </button>
    <button class="row" id="pause" type="button" role="switch" aria-checked="false" title="Stop all keyboard and mouse input from the phone">
      <span class="row-ic">${LINK_ICONS.pause}</span>
      <span class="row-t"><b>Pause all</b><small>Nothing reaches any program while paused</small></span>
      <span class="sw" aria-hidden="true"><i></i></span>
    </button>
  </section>
  <section class="panel glass" id="list" aria-label="Allowed programs"></section>
  <p class="note" id="note" role="alert" hidden></p>
  <p class="foot" id="foot"></p>`

const $ = (id: string) => document.getElementById(id) as HTMLElement
const send = (m: BgRequest): Promise<unknown> => chrome.runtime.sendMessage(m).catch((e: unknown) => ({ ok: false, error: String(e) }))

function programRow(p: PcProgramEntry): HTMLElement {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML = `
    <span class="row-ic">${LINK_ICONS.pc}</span>
    <span class="row-t"><b></b><small></small></span>
    <span class="kinds" role="group" aria-label="Allowed input">
      <button class="kind" type="button" data-kind="keyboard" aria-pressed="${p.keyboard}" title="Keyboard">${LINK_ICONS.keys}<span>keys</span></button>
      <button class="kind" type="button" data-kind="mouse" aria-pressed="${p.mouse}" title="Mouse">${LINK_ICONS.mouse}<span>mouse</span></button>
    </span>
    <button class="icon-btn" type="button" data-act="forget" title="Remove" aria-label="Stop allowing this program">${ICONS.close}</button>`
  row.querySelector('b')!.textContent = p.name
  row.querySelector('small')!.textContent = p.path
  for (const b of row.querySelectorAll<HTMLButtonElement>('.kind')) {
    b.addEventListener('click', () => {
      const next = { keyboard: p.keyboard, mouse: p.mouse }
      next[b.dataset.kind as 'keyboard' | 'mouse'] = b.getAttribute('aria-pressed') !== 'true'
      void send({ to: 'bg', type: 'pc-scope', path: p.path, ...next })
    })
  }
  row.querySelector<HTMLButtonElement>('[data-act=forget]')!.addEventListener('click', () => void send({ to: 'bg', type: 'pc-forget', path: p.path }))
  return row
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

  const list = $('list')
  list.replaceChildren()
  const programs = pc.config?.programs ?? []
  if (programs.length) {
    for (const p of programs) list.append(programRow(p))
  } else {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.innerHTML = `${LINK_ICONS.pc}<b>No programs allowed</b><span>Switch to a program, open ob.Pal Link and choose PC to allow it.</span>`
    list.append(empty)
  }

  const note = $('note')
  const notice = noticeFor()
  note.hidden = !notice
  note.replaceChildren()
  if (notice) {
    note.append(notice.text)
    if (notice.action) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = notice.action.label
      b.onclick = notice.action.run
      note.append(' ', b)
    }
  }

  const foot = $('foot')
  foot.replaceChildren()
  if (ready) {
    const v = document.createElement('span')
    v.innerHTML = `<b>ob.Pal Desktop</b> ${pc.version ?? ''}`
    foot.append(v)
    const h = document.createElement('span')
    h.innerHTML = pc.hotkey ? `Panic key <span class="hotkey"></span>` : 'No panic key (the combination is taken)'
    if (pc.hotkey) h.querySelector('.hotkey')!.textContent = pc.hotkey
    foot.append(h)
    const s = document.createElement('span')
    s.textContent = desktop
      ? 'Every window receives input, except those running as administrator: Windows keeps them out of reach.'
      : 'Only the program in front receives input, and only the kinds allowed here.'
    foot.append(s)
  }
}

function noticeFor(): { text: string; action?: { label: string; run: () => void } } | null {
  switch (pc.link) {
    case 'ready':
      return null
    case 'permission':
      return permission ? null : { text: 'PC control is off.', action: { label: 'Turn on', run: requestPermission } }
    case 'missing':
      return { text: 'ob.Pal Desktop isn’t installed.', action: { label: 'How to install', run: () => void chrome.tabs.create({ url: 'https://github.com/Axialon/obpal-link/tree/main/desktop#readme' }) } }
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
  if (area !== 'session' || !changes.pc) return
  pc = parsePcState(changes.pc.newValue) ?? { ...EMPTY_PC }
  render()
})

async function init() {
  const [session, granted] = await Promise.all([chrome.storage.session.get('pc'), chrome.permissions.contains(NATIVE_PERMISSION)])
  pc = parsePcState(session.pc) ?? { ...EMPTY_PC }
  permission = granted
  render()
  // Holding this port keeps the helper up while the page is open (it closes with the page).
  if (granted) chrome.runtime.connect({ name: PC_PAGE_PORT_NAME })
}

void init()
