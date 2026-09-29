/**
 * Popup: the ob.Pal lockup with the link's status, and the controls: what the phone drives (Controller / 3D / Keys /
 * PC), and where: this tab (with the optional "All sites" permission), or for the PC target, ob.Pal Desktop: the whole
 * PC, or the program in front (allow it, or see what is being controlled), with the gestures that drive it. While no
 * phone is connected the pairing QR sits beside the controls; once one is, it is the status in the bar (its name, and
 * × to disconnect) and the controls have the popup to themselves. The palette button picks the surface and colour
 * (../ui/look.ts). It renders from storage (written by the service worker) and asks the worker to change things.
 *
 * Two kinds of code: the online one (through the room service) and, for a remembered phone, a direct LAN code
 * that needs no server. The direct code takes over by itself while the service is unreachable; the chips under
 * the QR switch by hand. Remembered phones can be forgotten here.
 *
 * A phone that wants the PC and hasn't been answered for yet gets the prompt at the top (../ui/ask.ts); one this PC
 * said no to shows in the PC card, with the way to allow it after all.
 */
import { family } from '../../../src/family'
import '../../../src/styles/base.css'
import '../ui/link.css'
import './popup.css'
import { renderSVG } from 'uqr'
import { ICONS, LOGO_WORD } from '../../../src/ui/icons'
import { accessOf, askFor, parseAnswers, parsePhone, type Answers, type Phone } from '../shared/access'
import { DEFAULT_MODE, isTargetMode, TARGET_MODES, type TargetMode } from '../shared/constants'
import { parseFacts, parseLink, workerStale, type BgRequest, type LinkFacts, type LinkState, type LinkStatus } from '../shared/messages'
import { DESKTOP_URL, MAC_ACCESSIBILITY, EMPTY_PC, parsePcState, pcView, scopeLabel, type PcState, type PcView } from '../shared/native'
import { askCard, showAsk } from '../ui/ask'
import { lightCards, markContext, mountLogo, mountLook, settle, startLook, syncLook } from '../ui/look'
import { radioGroup } from '../ui/radios'
import { LINK_ICONS } from './icons'

markContext()
startLook()

const ALL_SITES: chrome.permissions.Permissions = { origins: ['<all_urls>'] }
const NATIVE_PERMISSION: chrome.permissions.Permissions = { permissions: ['nativeMessaging'] }

/**
 * The targets: the label, a few words under it where there is room, what it does (said under the tiles while they
 * have no room for those words), and the glyph.
 */
const MODES: Record<TargetMode, { label: string; sub: string; says: string; icon: string }> = {
  gamepad: { label: 'Controller', sub: 'Gamepad API', says: 'A virtual gamepad for Gamepad API games', icon: LINK_ICONS.gamepad },
  viewer: { label: '3D', sub: '3D viewers', says: 'Drag to rotate, pan and zoom a 3D view', icon: ICONS.cube },
  keys: { label: 'Keys', sub: 'WASD · arrows', says: 'WASD, arrows, action keys and the mouse', icon: LINK_ICONS.keys },
  pc: { label: 'PC', sub: 'This computer', says: 'This computer’s mouse and keyboard, through ob.Pal Desktop', icon: LINK_ICONS.pc },
}
const STATUS: Record<LinkStatus, string> = { starting: 'Starting', ready: 'Ready', connecting: 'Connecting', connected: 'Connected', offline: 'Offline' }

/**
 * What the phone's gestures do on the PC, shown while it is being controlled: the trackpad's, Point's (a PC gets the
 * mouse face there: Left, Right and a wheel), and typing with the phone's own keyboard. [glyph, what it does, how,
 * the whole sentence].
 */
const GESTURES: { name: string; items: [string, string, string, string][] }[] = [
  {
    name: 'Trackpad',
    items: [
      [LINK_ICONS.tap, 'Click', 'tap', 'Tap: click (tap again: double-click)'],
      [LINK_ICONS.hold, 'Right-click', 'hold', 'Hold: right-click'],
      [LINK_ICONS.drag, 'Drag', 'hold, move', 'Hold, then move: drag'],
      [LINK_ICONS.scroll, 'Scroll', 'two fingers', 'Two fingers, or the wheel along the edge: scroll'],
      [LINK_ICONS.pinch, 'Zoom', 'pinch', 'Pinch: zoom'],
    ],
  },
  {
    name: 'Point',
    items: [
      [ICONS['mouse-left'], 'Click', 'Left', 'Left: click where it went down; hold it and aim away to drag'],
      [ICONS['mouse-right'], 'Right-click', 'Right', 'Right: right-click'],
      [ICONS.autoscroll, 'Scroll', 'the wheel', 'The wheel: turn it to scroll, tap it to middle-click, hold it and aim to scroll'],
      [ICONS['zoom-in'], 'Zoom', '+ −', '+ and −: zoom'],
    ],
  },
  {
    name: 'Keyboard',
    items: [
      [LINK_ICONS.type, 'Type', 'the phone’s keyboard', 'Keyboard in the tray, or Type when a text field has the focus: the phone’s own keyboard types into it, and its key row taps Esc, Tab, the arrows, Backspace and Enter'],
    ],
  },
]

type Code = 'auto' | 'cloud' | 'lan'
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
  /** Which code to show: auto picks the direct code while the service is unreachable. */
  code: Code
  /** PC target: what the helper reports, mirrored by the service worker. */
  pc: PcState
  pcPermission: boolean
  /** The phone connected now, as the service worker has it, and the answers for phones that wanted the PC. */
  phone: Phone | null
  answers: Answers
  /** What the phone's link says of itself (its badge). */
  facts: LinkFacts | null
  /** The running worker is older than these files: the folder was replaced without a reload. */
  stale: boolean
}
const state: State = {
  link: null, tab: null, mode: DEFAULT_MODE, allSites: false, current: null, busy: false, notice: null, frames: null, code: 'auto',
  pc: { ...EMPTY_PC }, pcPermission: false, phone: null, answers: {}, facts: null, stale: false,
}
const parseFrames = (x: unknown): State['frames'] => {
  const f = x as State['frames']
  return f && typeof f === 'object' && Number.isInteger(f.tab) && Number.isInteger(f.count) && typeof f.host === 'string' ? f : null
}

const app = document.getElementById('app') as HTMLElement
app.innerHTML = `
  <header class="bar rise">
    <span class="logo" aria-label="ob.Pal"><span class="mark-slot" data-mark></span>${LOGO_WORD}</span>
    <span class="tag">Link</span>
    <span class="conn" id="conn">
      <span class="status" id="status" role="status"><i aria-hidden="true"></i><span id="status-t"></span><b id="device-name" hidden></b></span>
      <span class="facts" id="facts" hidden>${ICONS.lock}<span id="facts-t"></span></span>
      <button class="unpair" id="unpair" type="button" title="Disconnect" aria-label="Disconnect the phone" hidden>${ICONS.close}</button>
    </span>
    <button class="icon-btn" id="look" type="button" title="Surface and colour" aria-label="Surface and colour">${ICONS.palette}</button>
  </header>
  <div class="bb-menu bb-glass look-menu" id="look-menu" aria-label="Surface and colour" hidden></div>
  <div class="grid">
    <section class="card pair rise" id="pair" style="--i:1" aria-label="Phone">
      <div class="scan" id="scan">
        <div class="qr" id="qr" role="img" aria-label="Pairing QR code"></div>
        <p class="scan-hint" id="scan-hint">${ICONS.phone}<span id="scan-t">Scan with your phone</span></p>
        <div class="codes" id="codes" role="radiogroup" aria-label="Which code to show" hidden>
          <button class="code" type="button" role="radio" data-code="cloud" title="Through ob.Pal (needs internet)">${LINK_ICONS.cloud}<span>Online</span></button>
          <button class="code" type="button" role="radio" data-code="lan" title="Direct over Wi-Fi, no internet needed (remembered phones only)">${LINK_ICONS.lan}<span>Direct</span></button>
        </div>
        <div class="remembered" id="remembered" aria-label="Remembered phones" hidden></div>
      </div>
    </section>
    <section class="card controls rise" style="--i:2" aria-label="Controls">
      <div class="chips" role="radiogroup" aria-label="What the phone controls">
        ${TARGET_MODES.map((m) => `<button class="chip" type="button" role="radio" aria-checked="false" data-mode="${m}" title="${MODES[m].label}: ${MODES[m].says}">${MODES[m].icon}<span class="chip-t"><b>${MODES[m].label}</b><small>${MODES[m].sub}</small></span></button>`).join('')}
      </div>
      <p class="says" id="says"></p>
      <button class="row swap" id="tab" type="button" role="switch" aria-checked="false" title="Let the phone control this tab">
        <span class="row-ic">${LINK_ICONS.tab}</span>
        <span class="row-t"><b>This tab</b><small id="tab-host"></small></span>
        <span class="sw" aria-hidden="true"><i></i></span>
      </button>
      <div class="pc swap" id="pc" hidden>
        <div class="pc-helper" id="pc-helper" hidden>
          <span class="pc-ver" id="pc-ver"></span>
          <span class="pc-panic" id="pc-panic" title="The panic key: it stops everything at once" hidden></span>
          <button class="icon-btn" id="pc-list" type="button" title="Allowed programs" aria-label="Allowed programs">${ICONS.settings}</button>
        </div>
        <div class="pc-state">
          <div class="pc-main">
            <span class="pc-ic" id="pc-ic"></span>
            <span class="row-t"><b id="pc-title"></b><small id="pc-sub"></small></span>
          </div>
          <div class="kinds swap" id="pc-kinds" role="group" aria-label="What to allow" hidden>
            <button class="kind" type="button" data-kind="keyboard" aria-pressed="true">${LINK_ICONS.keys}<span>keys</span></button>
            <button class="kind" type="button" data-kind="mouse" aria-pressed="true">${LINK_ICONS.mouse}<span>mouse</span></button>
          </div>
          <div class="pc-actions" id="pc-actions"></div>
        </div>
        <div class="pc-legend swap" id="pc-legend" hidden>
          ${GESTURES.map((g) => `<div class="lg" role="group" aria-label="${g.name}"><p class="eyebrow">${g.name}</p><div class="lg-row">${g.items.map(([icon, what, how, title]) => `<span class="lg-i" title="${title}">${icon}<b>${what}</b><small>${how}</small></span>`).join('')}</div></div>`).join('')}
        </div>
      </div>
      <button class="row swap" id="all" type="button" role="switch" aria-checked="false" title="Reach game frames hosted on other sites, and keep control across navigation">
        <span class="row-ic">${LINK_ICONS.globe}</span>
        <span class="row-t"><b>All sites</b><small>Frames from other sites</small></span>
        <span class="sw" aria-hidden="true"><i></i></span>
      </button>
      <p class="note swap" id="note" role="alert" hidden></p>
    </section>
  </div>`

mountLogo(app)
lightCards()
const lookMenu = document.getElementById('look-menu') as HTMLElement
mountLook(lookMenu)
family.popover(document.getElementById('look') as HTMLElement, lookMenu, (m) => syncLook(m))
// A phone's question for the PC, over the cards.
const askEl = askCard((key, allow) => void send({ to: 'bg', type: 'answer', key, allow }))
app.insertBefore(askEl, app.querySelector('.grid'))

const $ = (id: string) => document.getElementById(id) as HTMLElement
const tabBtn = $('tab') as HTMLButtonElement
const allBtn = $('all') as HTMLButtonElement
const chips = [...app.querySelectorAll<HTMLButtonElement>('.chip')]
const codeBtns = [...app.querySelectorAll<HTMLButtonElement>('.code')]
// The targets and the codes: the arrow keys move through each and choose.
radioGroup(app.querySelector('.chips') as HTMLElement)
radioGroup($('codes'))
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

/** The code on screen: the direct one when chosen, or by itself while the service is unreachable. */
function shownCode(): { kind: 'cloud' | 'lan'; url: string } {
  const l = state.link
  const lan = l?.lan ?? ''
  const useLan = !!lan && (state.code === 'lan' || (state.code === 'auto' && l?.status === 'offline'))
  return useLan ? { kind: 'lan', url: lan } : { kind: 'cloud', url: l?.url ?? '' }
}

function render() {
  const link = state.link
  const status = link?.status ?? 'starting'
  const connected = status === 'connected'
  // Connected, the phone itself is the status: its name, lit, with × to disconnect; the pairing card steps aside.
  $('status').dataset.s = status
  $('conn').dataset.s = status
  $('status-t').textContent = STATUS[status]
  $('device-name').hidden = !connected
  $('device-name').textContent = link?.device || 'Phone'
  $('unpair').hidden = !connected
  renderFacts()
  app.classList.toggle('linked', connected)
  $('pair').hidden = connected
  // Answered, the question goes, and the focus it had moves on to the target chosen.
  showAsk(askEl, askFor(state.mode, connectedPhone(), state.answers, state.pcPermission), () => chips.find((c) => c.getAttribute('aria-checked') === 'true')?.focus())
  const code = shownCode()
  const lanPhone = link?.pairs.find((p) => p.id === link.lanFor)
  const qr = $('qr')
  // No code while offline with nobody remembered: say so in its place, rather than seem to be still making one.
  const qrKey = code.url || (status === 'offline' ? 'offline' : '')
  if (!connected && qrKey !== qrFor) {
    qrFor = qrKey
    qr.innerHTML = code.url ? renderSVG(code.url, { ecc: code.kind === 'lan' ? 'L' : 'M', border: 1, blackColor: '#0a0a0a', whiteColor: '#ffffff' }) : status === 'offline' ? `<span class="qr-off">${LINK_ICONS.cloudOff}</span>` : '<span class="qr-wait"></span>'
    // A new code: a scan line sweeps down it once.
    qr.classList.remove('sweep')
    if (code.url) {
      void qr.offsetWidth
      qr.classList.add('sweep')
    }
  }
  qr.classList.toggle('off', !code.url && status === 'offline')
  qr.dataset.kind = code.kind
  $('scan-hint').replaceChildren()
  $('scan-hint').insertAdjacentHTML('afterbegin', code.kind === 'lan' ? LINK_ICONS.lan : ICONS.phone)
  const hint = document.createElement('span')
  hint.id = 'scan-t'
  hint.textContent = code.kind === 'lan' ? `Direct link${lanPhone ? ` · ${lanPhone.name}` : ''}` : status === 'offline' ? 'No internet' : 'Scan with your phone'
  $('scan-hint').append(hint)
  $('scan-hint').classList.toggle('warn', code.kind === 'cloud' && status === 'offline')
  $('scan-hint').classList.toggle('direct', code.kind === 'lan')

  const hasLan = !!link?.lan
  $('codes').hidden = !hasLan
  for (const b of codeBtns) b.setAttribute('aria-checked', String(b.dataset.code === code.kind))

  renderRemembered(connected)

  const cur = state.current
  const can = scriptable(cur?.url)
  tabBtn.setAttribute('aria-checked', String(cur?.id !== undefined && state.tab === cur.id))
  tabBtn.setAttribute('aria-busy', String(state.busy))
  tabBtn.disabled = state.busy || !can
  $('tab-host').textContent = can ? hostOf(cur?.url) : 'Not available on this page'

  for (const c of chips) c.setAttribute('aria-checked', String(c.dataset.mode === state.mode))
  const says = $('says')
  says.hidden = state.mode === 'pc'
  if (says.textContent !== MODES[state.mode].says) {
    says.textContent = MODES[state.mode].says
    says.classList.remove('new')
    void says.offsetWidth
    says.classList.add('new')
  }
  allBtn.setAttribute('aria-checked', String(state.allSites))
  renderPc()

  const note = $('note')
  const notice = staleHint() ?? state.notice ?? offlineHint() ?? (state.mode === 'pc' ? null : framesHint())
  note.hidden = !notice
  note.replaceChildren()
  if (notice) {
    const { text, action } = notice
    note.insertAdjacentHTML('afterbegin', LINK_ICONS.info)
    const t = document.createElement('span')
    t.textContent = text
    note.append(t)
    if (action) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = action.label
      b.onclick = action.run
      note.append(b)
    }
  }
}

/**
 * The link's badge beside the phone's name, as the pairing chip shows it: a lock, the path in a word and the round
 * trip; its title says all of it (encrypted end to end, how the phone proved itself, the path, DTLS). Only what the
 * connection's own statistics say, and only once it's encrypted.
 */
const VERIFIED: Record<LinkFacts['verified'], string> = { qr: 'Verified by the QR code', code: 'Verified by the code typed', lan: 'Verified by a remembered pairing' }
const PATH: Record<LinkFacts['path'], [short: string, long: string]> = {
  lan: ['Direct', 'Direct, on the same network'], nat: ['Direct', 'Direct, over the internet'], direct: ['Direct', 'Direct, peer to peer'],
  relay: ['Relayed', 'Relayed through TURN, which can’t read it'], unknown: ['', 'Finding the path'],
}
/** Asked of the link every FACTS_MS while the popup is open, and at once when a phone connects. */
const FACTS_MS = 2000
async function pollFacts() {
  state.facts = state.link?.status === 'connected' ? parseFacts(await send({ to: 'bg', type: 'facts' })) : null
  renderFacts()
}
function renderFacts() {
  const f = state.link?.status === 'connected' ? state.facts : null
  const el = $('facts')
  el.hidden = !f
  if (!f) return
  const rtt = f.rttMs !== undefined ? `${f.rttMs} ms` : ''
  $('facts-t').textContent = [PATH[f.path][0], rtt].filter(Boolean).join(' · ')
  const path = f.path === 'relay' && f.relay ? `Relayed through TURN over ${f.relay.toUpperCase()}, which can’t read it` : PATH[f.path][1]
  const dtls = [f.dtls, f.cipher].filter(Boolean).join(', ')
  el.title = [`Encrypted end to end${dtls ? ` (${dtls})` : ''}`, VERIFIED[f.verified], path, ...(rtt ? [`${rtt} round trip`] : [])].join('\n')
}

/** Remembered phones as chips: tap one to make the direct code for it, × to forget it. */
function renderRemembered(connected: boolean) {
  const box = $('remembered')
  const pairs = state.link?.pairs ?? []
  box.hidden = connected || pairs.length === 0
  box.replaceChildren()
  for (const p of pairs) {
    const chip = document.createElement('span')
    chip.className = 'phone'
    chip.dataset.id = p.id
    chip.setAttribute('aria-current', String(p.id === state.link?.lanFor))
    const pick = document.createElement('button')
    pick.type = 'button'
    pick.className = 'phone-pick'
    pick.title = 'Direct code for this phone'
    pick.insertAdjacentHTML('afterbegin', ICONS.phone)
    const name = document.createElement('span')
    name.textContent = p.name
    pick.append(name)
    pick.onclick = () => { if (p.id !== state.link?.lanFor) void send({ to: 'bg', type: 'lan', id: p.id }) }
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'phone-x'
    x.title = `Forget ${p.name}`
    x.setAttribute('aria-label', `Forget ${p.name}`)
    x.innerHTML = ICONS.close
    x.onclick = () => void send({ to: 'bg', type: 'forget', id: p.id })
    chip.append(pick, x)
    box.append(chip)
  }
}

/** Offline with nobody remembered: only an online pairing can start a direct link later. */
function offlineHint(): Notice | null {
  const l = state.link
  if (!l || l.status !== 'offline' || l.lan || l.pairs.length) return null
  return { text: 'ob.Pal can’t be reached. Pair once online and a phone can connect over Wi-Fi without it.' }
}

/** New files, old worker: one click restarts the extension from its folder (as the reload button does). */
function staleHint(): Notice | null {
  return state.stale ? { text: 'ob.Pal Link was updated. Restart it to finish.', action: { label: 'Restart', run: () => chrome.runtime.reload() } } : null
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

// ---- PC target: the program in front, and what the helper is doing -------------------------------------

interface PcAction { label: string; primary?: boolean; run: () => void }
/** How the PC card's glyph reads: live (input flows), warn (it can't), rest (paused or stopped), or plain. */
type PcTone = 'live' | 'warn' | 'rest' | 'plain'
/** The PC card's content: glyph, what is controlled, what to do about it, and whether the gestures show. */
interface PcCard { icon: string; title: string; sub: string; actions: PcAction[]; kinds: boolean; live: boolean; tone: PcTone }
/** The helper's views that say what is controlled: those wait on the phone being let in. */
const CONTROL_VIEWS = new Set<PcView['kind']>(['desktop', 'idle', 'allow', 'elevated', 'active'])

/** The phone connected now, as the service worker has it (null while none is). */
const connectedPhone = (): Phone | null => (state.link?.status === 'connected' ? state.phone : null)

/**
 * The PC card while the phone connected now isn't let in (ob.Pal Desktop stays disarmed meanwhile): waiting for the
 * answer the prompt above asks for, or refused, with the way to allow it after all. Null: the helper's own state
 * decides the card (the phone is allowed, none is connected, or the helper can't run anyway).
 */
function accessCard(v: PcView): PcCard | null {
  const phone = connectedPhone()
  if (!phone || !CONTROL_VIEWS.has(v.kind)) return null
  const access = accessOf(state.answers, phone.key)
  if (access === 'allow') return null
  if (access === 'ask') return { icon: ICONS.phone, title: 'Waiting for your answer', sub: `${phone.name} asks to control this PC`, actions: [], kinds: false, live: false, tone: 'plain' }
  return {
    icon: LINK_ICONS.shield, title: `${phone.name} can’t control this PC`, sub: 'You said no. Its other targets still work.', kinds: false, live: false, tone: 'warn',
    actions: [{ label: `Allow ${phone.name}`, run: () => void send({ to: 'bg', type: 'answer', key: phone.key, allow: true }) }],
  }
}
const pcKinds = [...app.querySelectorAll<HTMLButtonElement>('#pc-kinds .kind')]
const pressed = (b: HTMLButtonElement) => b.getAttribute('aria-pressed') === 'true'
for (const b of pcKinds) b.addEventListener('click', () => b.setAttribute('aria-pressed', String(!pressed(b))))
$('pc-list').addEventListener('click', () => void chrome.runtime.openOptionsPage())

/** The PC card replaces the tab controls while the target is PC: the phone drives the PC, not a tab. */
function renderPc() {
  const on = state.mode === 'pc'
  $('pc').hidden = !on
  tabBtn.hidden = on
  allBtn.hidden = on
  if (!on) return
  const view = state.pcPermission ? pcView(state.pc) : { kind: 'permission' as const }
  const { icon, title, sub, actions, kinds, live, tone } = accessCard(view) ?? describe(view)
  $('pc-legend').hidden = !live
  const ic = $('pc-ic')
  ic.innerHTML = icon
  ic.dataset.tone = tone
  $('pc-title').textContent = title
  $('pc-sub').textContent = sub
  $('pc-kinds').hidden = !kinds
  renderHelper()
  const box = $('pc-actions')
  box.replaceChildren()
  for (const a of actions) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = a.primary ? 'btn primary' : 'btn'
    b.textContent = a.label
    b.onclick = a.run
    box.append(b)
  }
  box.hidden = !actions.length
}

/** Above the PC card, once ob.Pal Desktop answers: its version, the panic key that stops everything, and the list. */
function renderHelper() {
  const pc = state.pc
  const ready = state.pcPermission && pc.link === 'ready'
  $('pc-helper').hidden = !ready
  $('pc-list').hidden = pc.link !== 'ready'
  if (!ready) return
  // "ob.Pal" gives way first where the card is narrow, so the version always shows.
  const brand = document.createElement('span')
  brand.className = 'pc-brand'
  brand.textContent = 'ob.Pal '
  $('pc-ver').replaceChildren(brand, `Desktop${pc.version ? ` ${pc.version}` : ''}`)
  $('pc-ver').title = pc.platform ? 'macOS preview: awaiting a first Mac test. Ctrl shortcuts use ' + (pc.platform.ctrlToCmd ? '⌘ Command' : 'Control') + '; Alt is ⌥ Option.' : ''
  const panic = $('pc-panic')
  panic.hidden = !pc.hotkey
  panic.replaceChildren()
  const label = document.createElement('span')
  label.textContent = 'Panic key'
  panic.append(label)
  for (const k of pc.hotkey?.split('+') ?? []) {
    const key = document.createElement('kbd')
    key.textContent = k
    panic.append(key)
  }
}

function describe(v: PcView): PcCard {
  const pc = LINK_ICONS.pc
  const retry: PcAction = { label: 'Retry', run: () => void send({ to: 'bg', type: 'pc-connect' }) }
  const pause: PcAction = { label: 'Pause', run: () => void send({ to: 'bg', type: 'pc-pause', on: true }) }
  /** Offered beside the one-program views: the whole PC, or the helper update that brings it. */
  const whole = (desktop: boolean, primary = false): PcAction =>
    desktop
      ? { label: primary ? 'Control the whole PC' : 'Whole PC', primary, run: () => setDesktop(true) }
      : { label: 'Update for whole PC', run: () => void chrome.tabs.create({ url: DESKTOP_URL }) }
  switch (v.kind) {
    case 'accessibility':
      return { icon: LINK_ICONS.shield, title: 'Allow Accessibility on this Mac', sub: MAC_ACCESSIBILITY, actions: [{ label: 'Mac setup', run: () => void chrome.tabs.create({ url: `${DESKTOP_URL.replace('#readme', '')}#install-on-a-mac` }) }], kinds: false, live: false, tone: 'warn' }
    case 'permission':
      return { icon: pc, title: 'PC', sub: 'This computer’s mouse and keyboard', actions: [{ label: 'Allow PC control', primary: true, run: requestNative }], kinds: false, live: false, tone: 'plain' }
    case 'connecting':
      return { icon: pc, title: 'Starting…', sub: 'ob.Pal Desktop', actions: [], kinds: false, live: false, tone: 'plain' }
    case 'missing':
      return {
        icon: LINK_ICONS.shield, title: 'ob.Pal Desktop isn’t installed', sub: 'Install it, then retry', kinds: false, live: false, tone: 'warn',
        actions: [{ label: 'Install', primary: true, run: () => void chrome.tabs.create({ url: DESKTOP_URL }) }, retry],
      }
    case 'error':
      return { icon: LINK_ICONS.shield, title: 'Helper stopped', sub: v.error, actions: [retry], kinds: false, live: false, tone: 'warn' }
    case 'paused':
      return { icon: LINK_ICONS.pause, title: 'Paused', sub: 'Nothing reaches any program', actions: [{ label: 'Resume', primary: true, run: () => void send({ to: 'bg', type: 'pc-pause', on: false }) }], kinds: false, live: false, tone: 'rest' }
    case 'panic':
      return { icon: LINK_ICONS.pause, title: 'Stopped', sub: v.hotkey ? `Panic key ${v.hotkey}` : 'Panic key', actions: [{ label: 'Resume', primary: true, run: () => void send({ to: 'bg', type: 'pc-resume' }) }], kinds: false, live: false, tone: 'rest' }
    case 'desktop': {
      const blocked = v.front?.elevated ? `${v.front.name} runs as administrator: Windows keeps it out of reach` : ''
      return {
        icon: pc, title: 'Controlling this PC', sub: blocked || `${scopeLabel(v.scope)} · every window`, kinds: false, live: true, tone: blocked ? 'warn' : 'live',
        actions: [pause, { label: 'One program', run: () => setDesktop(false) }],
      }
    }
    case 'idle':
      return v.desktop
        ? { icon: pc, title: 'This PC', sub: 'Every window, or one program: switch to it, then come back', actions: [whole(true, true)], kinds: true, live: false, tone: 'plain' }
        : { icon: pc, title: 'Switch to a program', sub: 'Then come back here to allow it', actions: [whole(false)], kinds: false, live: false, tone: 'plain' }
    case 'elevated':
      return { icon: LINK_ICONS.shield, title: v.program.name, sub: 'Runs as administrator: can’t be controlled', actions: [whole(v.desktop)], kinds: v.desktop, live: false, tone: 'warn' }
    case 'allow':
      return {
        icon: pc, title: v.program.name, sub: v.program.title || v.program.path, kinds: true, live: false, tone: 'plain',
        actions: [{ label: `Allow ${v.program.name}`, primary: true, run: () => allowProgram(v.program.path) }, whole(v.desktop)],
      }
    case 'active':
      return {
        icon: pc, title: v.inFront ? `Controlling ${v.program.name}` : v.program.name, live: v.inFront, kinds: false, tone: v.inFront ? 'live' : 'plain',
        sub: scopeLabel(v.scope) + (v.inFront ? '' : ' · switch to it'),
        actions: [pause, whole(v.desktop)],
      }
  }
}

/** Whole-PC mode on (with the kinds chosen above) or off (back to one program at a time). */
function setDesktop(on: boolean) {
  const kind = (k: string) => pressed(pcKinds.find((b) => b.dataset.kind === k)!)
  const keyboard = on ? kind('keyboard') : true
  const mouse = on ? kind('mouse') : true
  void send({ to: 'bg', type: 'pc-desktop', on, keyboard, mouse })
}

function allowProgram(path: string) {
  const kind = (k: string) => pressed(pcKinds.find((b) => b.dataset.kind === k)!)
  void send({ to: 'bg', type: 'pc-allow', path, keyboard: kind('keyboard'), mouse: kind('mouse') })
}

// permissions.request() must run inside the click's user gesture, before anything is awaited.
function requestNative(then?: () => void) {
  chrome.permissions.request(NATIVE_PERMISSION).then((granted) => {
    state.pcPermission = granted
    if (granted) then?.()
    render()
  }, () => render())
}

function setMode(mode: TargetMode) {
  state.mode = mode
  render()
  void send({ to: 'bg', type: 'mode', mode })
}

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
    // The PC target needs the optional nativeMessaging permission: ask on the first switch, in this click.
    if (mode === 'pc' && !state.pcPermission) return requestNative(() => setMode('pc'))
    setMode(mode)
  })
}

for (const b of codeBtns) {
  b.addEventListener('click', () => {
    state.code = b.dataset.code === 'lan' ? 'lan' : 'cloud'
    render()
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
    if (changes.link) {
      const was = state.link?.status
      state.link = parseLink(changes.link.newValue)
      if (state.link?.status !== was) void pollFacts()
    }
    if (changes.frames) state.frames = parseFrames(changes.frames.newValue)
    if (changes.pc) state.pc = parsePcState(changes.pc.newValue) ?? { ...EMPTY_PC }
    if (changes.phone) state.phone = parsePhone(changes.phone.newValue)
  } else if (area === 'local') {
    if (changes.mode && isTargetMode(changes.mode.newValue)) state.mode = changes.mode.newValue
    if (changes.answers) state.answers = parseAnswers(changes.answers.newValue)
  }
  render()
})

const refreshPermissions = async () => {
  ;[state.allSites, state.pcPermission] = await Promise.all([chrome.permissions.contains(ALL_SITES), chrome.permissions.contains(NATIVE_PERMISSION)])
  render()
}
chrome.permissions.onAdded.addListener(() => void refreshPermissions())
chrome.permissions.onRemoved.addListener(() => void refreshPermissions())

async function init() {
  render()
  void send({ to: 'bg', type: 'ensure' })
  const [tabs, session, local, allSites, pcPermission] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.session.get(['tab', 'link', 'frames', 'pc', 'phone']),
    chrome.storage.local.get(['mode', 'answers']),
    chrome.permissions.contains(ALL_SITES),
    chrome.permissions.contains(NATIVE_PERMISSION),
  ])
  state.current = tabs[0] ?? null
  state.tab = typeof session.tab === 'number' ? session.tab : null
  state.link = parseLink(session.link)
  state.frames = parseFrames(session.frames)
  state.pc = parsePcState(session.pc) ?? { ...EMPTY_PC }
  state.phone = parsePhone(session.phone)
  state.answers = parseAnswers(local.answers)
  state.mode = isTargetMode(local.mode) ? local.mode : DEFAULT_MODE
  state.allSites = allSites
  state.pcPermission = pcPermission
  render()
  settle()
  void pollFacts()
  setInterval(() => void pollFacts(), FACTS_MS)
  // With the PC target on, make sure the helper is up (the worker may have idled out) and reporting.
  if (state.mode === 'pc' && pcPermission) void send({ to: 'bg', type: 'pc-connect' })
  state.stale = workerStale(await send({ to: 'bg', type: 'version' }), chrome.runtime.getManifest().version)
  if (state.stale) render()
}

void init()
