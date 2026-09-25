/**
 * Popup: the ob.Pal lockup, the pairing QR (or the connected phone), and three controls: control this tab,
 * what the phone drives (Controller / 3D / Keys), and the optional "All sites" permission.
 * It renders from storage (written by the service worker) and asks the worker to change things.
 */
import { family } from '../../../src/family'
import '../../../src/styles/base.css'
import './popup.css'
import { renderSVG } from 'uqr'
import { ICONS, logo } from '../../../src/ui/icons'
import { DEFAULT_MODE, isTargetMode, TARGET_MODES, type TargetMode } from '../shared/constants'
import { parseLink, type BgRequest, type LinkState, type LinkStatus } from '../shared/messages'
import { LINK_ICONS } from './icons'

family.setProduct('obpal') // ob.Pal Link wears ob.Pal's lime on the family surfaces

const ALL_SITES: chrome.permissions.Permissions = { origins: ['<all_urls>'] }

const MODES: Record<TargetMode, { label: string; icon: string; title: string }> = {
  gamepad: { label: 'Controller', icon: LINK_ICONS.gamepad, title: 'Controller: a virtual gamepad for Gamepad API games' },
  viewer: { label: '3D', icon: ICONS.cube, title: '3D viewer: drag to rotate, pan and zoom' },
  keys: { label: 'Keys', icon: LINK_ICONS.keys, title: 'Keys: WASD, arrows, action keys and mouse' },
}
const STATUS: Record<LinkStatus, string> = { starting: 'Starting', ready: 'Ready', connecting: 'Connecting', connected: 'Connected', offline: 'Offline' }

interface Notice { text: string; action?: { label: string; run: () => void } }
interface State {
  link: LinkState | null
  tab: number | null
  mode: TargetMode
  allSites: boolean
  current: chrome.tabs.Tab | null
  busy: boolean
  notice: Notice | null
  /** Frames from other sites in the controlled tab, as its top frame reported them. */
  frames: { tab: number; count: number; host: string; big: boolean } | null
}
const state: State = { link: null, tab: null, mode: DEFAULT_MODE, allSites: false, current: null, busy: false, notice: null, frames: null }
const parseFrames = (x: unknown): State['frames'] => {
  const f = x as State['frames']
  return f && typeof f === 'object' && Number.isInteger(f.tab) && Number.isInteger(f.count) && typeof f.host === 'string' ? f : null
}

const app = document.getElementById('app') as HTMLElement
app.innerHTML = `
  <header class="bar">
    <span class="logo" aria-label="ob.Pal">${logo()}</span>
    <span class="tag">Link</span>
    <span class="status" id="status" role="status"><i aria-hidden="true"></i><span id="status-t"></span></span>
  </header>
  <section class="pair glass" aria-label="Phone">
    <div class="scan" id="scan">
      <div class="qr" id="qr" role="img" aria-label="Pairing QR code"></div>
      <p class="scan-hint">${ICONS.phone}<span>Scan with your phone</span></p>
    </div>
    <div class="device" id="device" hidden>
      <span class="device-ic">${ICONS.phone}</span>
      <span class="device-t"><b id="device-name"></b><small>Connected</small></span>
      <button class="icon-btn" id="unpair" type="button" title="Disconnect" aria-label="Disconnect the phone">${ICONS.close}</button>
    </div>
  </section>
  <section class="panel glass">
    <button class="row" id="tab" type="button" role="switch" aria-checked="false" title="Let the phone control this tab">
      <span class="row-ic">${LINK_ICONS.tab}</span>
      <span class="row-t"><b>This tab</b><small id="tab-host"></small></span>
      <span class="sw" aria-hidden="true"><i></i></span>
    </button>
    <div class="chips" role="radiogroup" aria-label="What the phone controls">
      ${TARGET_MODES.map((m) => `<button class="chip" type="button" role="radio" aria-checked="false" data-mode="${m}" title="${MODES[m].title}">${MODES[m].icon}<span>${MODES[m].label}</span></button>`).join('')}
    </div>
    <button class="row" id="all" type="button" role="switch" aria-checked="false" title="Reach game frames hosted on other sites, and keep control across navigation">
      <span class="row-ic">${LINK_ICONS.globe}</span>
      <span class="row-t"><b>All sites</b><small>Frames from other sites</small></span>
      <span class="sw" aria-hidden="true"><i></i></span>
    </button>
    <p class="note" id="note" role="alert" hidden></p>
  </section>`

const $ = (id: string) => document.getElementById(id) as HTMLElement
const tabBtn = $('tab') as HTMLButtonElement
const allBtn = $('all') as HTMLButtonElement
const chips = [...app.querySelectorAll<HTMLButtonElement>('.chip')]
let qrFor: string | null = null

const RESTRICTED = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i
const scriptable = (url: string | undefined) => !!url && /^(https?|file):/i.test(url) && !RESTRICTED.test(url)
function hostOf(url: string | undefined) {
  try {
    const u = new URL(url ?? '')
    return u.protocol === 'file:' ? 'Local file' : u.host
  } catch {
    return ''
  }
}

function render() {
  const status = state.link?.status ?? 'starting'
  $('status').dataset.s = status
  $('status-t').textContent = STATUS[status]

  const connected = status === 'connected'
  $('scan').hidden = connected
  $('device').hidden = !connected
  $('device-name').textContent = state.link?.device || 'Phone'
  const url = state.link?.url ?? ''
  if (!connected && url !== qrFor) {
    qrFor = url
    $('qr').innerHTML = url ? renderSVG(url, { ecc: 'M', border: 1, blackColor: '#0a0a0a', whiteColor: '#ffffff' }) : '<span class="qr-wait"></span>'
  }

  const cur = state.current
  const can = scriptable(cur?.url)
  tabBtn.setAttribute('aria-checked', String(cur?.id !== undefined && state.tab === cur.id))
  tabBtn.setAttribute('aria-busy', String(state.busy))
  tabBtn.disabled = state.busy || !can
  $('tab-host').textContent = can ? hostOf(cur?.url) : 'Not available on this page'

  for (const c of chips) c.setAttribute('aria-checked', String(c.dataset.mode === state.mode))
  allBtn.setAttribute('aria-checked', String(state.allSites))

  const note = $('note')
  const notice = state.notice ?? framesHint()
  note.hidden = !notice
  note.replaceChildren()
  if (notice) {
    const { text, action } = notice
    note.append(text)
    if (action) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = action.label
      b.onclick = action.run
      note.append(' ', b)
    }
  }
}

/**
 * The controlled page shows a frame from another site (a hosted game, most often) and "All sites" is off: the
 * extension can't reach inside it, so the phone's input would go nowhere. Offer the fix in one click.
 */
function framesHint(): Notice | null {
  const f = state.frames
  const here = state.current?.id
  if (!f || state.allSites || here === undefined || state.tab !== here || f.tab !== here || f.count === 0) return null
  const where = f.host ? ` from ${f.host}` : ' from another site'
  const text = f.big ? `The game runs in a frame${where}. Turn on All sites to reach it.` : `This page has a frame${where} that ob.Pal can't reach yet.`
  return { text, action: { label: 'Turn on', run: requestAllSites } }
}

const send = (m: BgRequest): Promise<unknown> => chrome.runtime.sendMessage(m).catch((e: unknown) => ({ ok: false, error: String(e) }))
const isOk = (r: unknown) => typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === true

tabBtn.addEventListener('click', async () => {
  const id = state.current?.id
  if (id === undefined || state.busy) return
  const on = state.tab !== id
  state.busy = true
  state.notice = null
  render()
  const res = await send({ to: 'bg', type: 'enable', tabId: id, on })
  state.busy = false
  if (isOk(res)) state.tab = on ? id : null
  else state.notice = { text: 'This page can’t be controlled.' }
  render()
})

for (const chip of chips) {
  chip.addEventListener('click', () => {
    const mode = chip.dataset.mode
    if (!isTargetMode(mode) || mode === state.mode) return
    state.mode = mode
    render()
    void send({ to: 'bg', type: 'mode', mode })
  })
}

// permissions.request() must run inside the click's user gesture, before anything is awaited.
function requestAllSites() {
  chrome.permissions.request(ALL_SITES).then((granted) => { state.allSites = granted; render() }, () => render())
}
allBtn.addEventListener('click', () => {
  state.notice = null
  if (!state.allSites) return requestAllSites()
  chrome.permissions.remove(ALL_SITES).then(
    (removed) => { if (removed) state.allSites = false; render() },
    // If the browser refuses to revoke it here, site access can still be turned off in the extension's settings.
    () => {
      state.notice = { text: 'Turn off site access in the extension’s settings.', action: { label: 'Open', run: openSettings } }
      render()
    },
  )
})

function openSettings() {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
}

$('unpair').addEventListener('click', () => void send({ to: 'bg', type: 'unpair' }))

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') {
    if (changes.tab) state.tab = typeof changes.tab.newValue === 'number' ? changes.tab.newValue : null
    if (changes.link) state.link = parseLink(changes.link.newValue)
    if (changes.frames) state.frames = parseFrames(changes.frames.newValue)
  } else if (area === 'local' && changes.mode && isTargetMode(changes.mode.newValue)) {
    state.mode = changes.mode.newValue
  }
  render()
})

const refreshAllSites = async () => {
  state.allSites = await chrome.permissions.contains(ALL_SITES)
  render()
}
chrome.permissions.onAdded.addListener(() => void refreshAllSites())
chrome.permissions.onRemoved.addListener(() => void refreshAllSites())

async function init() {
  render()
  void send({ to: 'bg', type: 'ensure' })
  const [tabs, session, local, allSites] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.session.get(['tab', 'link', 'frames']),
    chrome.storage.local.get('mode'),
    chrome.permissions.contains(ALL_SITES),
  ])
  state.current = tabs[0] ?? null
  state.tab = typeof session.tab === 'number' ? session.tab : null
  state.link = parseLink(session.link)
  state.frames = parseFrames(session.frames)
  state.mode = isTargetMode(local.mode) ? local.mode : DEFAULT_MODE
  state.allSites = allSites
  render()
}

void init()
