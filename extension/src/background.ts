/**
 * Service worker: message routing and per-tab enablement.
 *  - Keeps the offscreen link document (the ob.Pal Remote) alive while it is needed.
 *  - "Control this tab" injects the bridge into every permitted frame of that tab; each bridge then says hello
 *    and gets the MAIN-world page script injected into its frame. Only one tab is controlled at a time.
 *  - With the optional "All sites" permission it also registers the bridge for new frames and navigations.
 *  - State: target mode in storage.local; controlled tab and link status in storage.session (the popup reads both).
 *  - Which phones may control the PC (shared/access.ts): the answers in storage.local, the phone connected now in
 *    storage.session. ob.Pal Desktop is armed only for a phone the person at the PC allowed; a phone nobody has
 *    answered for yet gets the popup's prompt, a badge, and a notification when those are allowed.
 */
import { NATIVE_PERMISSION, NativeBridge } from './native'
import {
  accessOf, askFor, parseAnswers, parsePhone, withAnswer, withoutAnswer, type Answers, type Phone,
} from './shared/access'
import { DEFAULT_MODE, isTargetMode, type TargetMode } from './shared/constants'
import {
  allowedFrom, linkConfig, parseBgRequest, parseLink, senderKind,
  type BgRequest, type BridgeRequest, type LinkConfig, type LinkState, type OffscreenRequest,
} from './shared/messages'
import { NATIVE_PORT_NAME, parseNativeFrame, parseNativeText, PC_PAGE_PORT_NAME } from './shared/native'

const OFFSCREEN_PATH = 'offscreen.html'
const BRIDGE_JS = 'bridge.js'
const PAGE_JS = 'page.js'
const REGISTERED_ID = 'obpal-link-bridge'
const ALL_SITES: chrome.permissions.Permissions = { origins: ['<all_urls>'] }
const SELF = { id: chrome.runtime.id, origin: chrome.runtime.getURL('').replace(/\/$/, '') }
/** The PC target: the native messaging port to ob.Pal Desktop, connected while the target is PC. */
const native = new NativeBridge()
// Whole PC on or off: the offscreen link switches the gamepad between the desktop and the game keys (the helper is
// armed once it has: NativeBridge waits for this).
native.onDesktop = () => pushConfig()
// A text field in front would take typing (or no longer would): the phone offers its keyboard. Typing that didn't
// get through: the phone says why.
native.onTextField = (field) => void toOffscreen({ to: 'offscreen', type: 'text-field', field })
native.onTyping = (refused) => void toOffscreen({ to: 'offscreen', type: 'typing', refused })

// ---- state -------------------------------------------------------------------------------------

async function controlledTab(): Promise<number | null> {
  const { tab } = await chrome.storage.session.get('tab')
  return typeof tab === 'number' ? tab : null
}

async function targetMode(): Promise<TargetMode> {
  const { mode } = await chrome.storage.local.get('mode')
  return isTargetMode(mode) ? mode : DEFAULT_MODE
}

async function linkState(): Promise<LinkState | null> {
  const { link } = await chrome.storage.session.get('link')
  return parseLink(link)
}

// ---- which phones may control the PC (spec/SECURITY.md §8, L1) -------------------------------------------------

const NOTIFY: chrome.permissions.Permissions = { permissions: ['notifications'] }
/** The one notification: a phone asks for the PC. Its buttons answer, and a click on it opens the options page's prompt. */
const ASK_NOTE = 'obpal-ask'

/** The phone connected now, as the link says (null: none). */
async function currentPhone(): Promise<Phone | null> {
  const { phone } = await chrome.storage.session.get('phone')
  return parsePhone(phone)
}

/** The person at the PC's answers, per phone. */
async function answers(): Promise<Answers> {
  const { answers: a } = await chrome.storage.local.get('answers')
  return parseAnswers(a)
}

/** The phone the badge and the notification ask about now (its key), or null. */
async function asking(): Promise<string | null> {
  const { asking: key } = await chrome.storage.session.get('asking')
  return typeof key === 'string' ? key : null
}

let reviewed: Promise<void> = Promise.resolve()
/**
 * Bring the helper and the question in line with who is connected and what they may do: ob.Pal Desktop is armed only
 * for the PC target and a phone the person at the PC allowed, and a phone nobody has answered for yet is asked about.
 * One review at a time, each reading the state after the one before: so the last to run, after the last change, has
 * the last word (an older read never arms the helper for a phone that has gone meanwhile).
 */
function reviewAccess(): Promise<void> {
  const review = async () => {
    const [mode, phone, list, pcReady] = await Promise.all([targetMode(), currentPhone(), answers(), chrome.permissions.contains(NATIVE_PERMISSION)])
    await native.sync(mode, !!phone && accessOf(list, phone.key) === 'allow')
    await showAsk(askFor(mode, phone, list, pcReady))
  }
  reviewed = reviewed.then(review).catch((e: unknown) => console.warn('[ob.Pal Link] could not review PC access', e))
  return reviewed
}

/**
 * The question on show: '!' on the toolbar icon while a phone waits (the popup has the prompt), and a notification with
 * Allow and Deny while notifications are allowed (options page). Nothing changes while it stays the same question.
 */
async function showAsk(ask: Phone | null) {
  if ((ask?.key ?? null) === (await asking())) return
  await chrome.storage.session.set({ asking: ask?.key ?? null })
  await refreshBadge()
  const notes = chrome.notifications
  if (!notes?.create) return
  if (!ask) return void notes.clear(ASK_NOTE).catch(() => {})
  if (!(await chrome.permissions.contains(NOTIFY))) return
  listenToNotes()
  await notes.create(ASK_NOTE, {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title: `${ask.name} wants to control this PC`,
    message: 'Mouse, keyboard and typing, through ob.Pal Desktop', buttons: [{ title: 'Allow' }, { title: 'Deny' }],
    requireInteraction: true, priority: 2,
  }).catch(() => {})
}

/**
 * The person at the PC answers for a phone: the popup's prompt or its PC card, the options page, or the notification.
 * Saying no to a phone that had just switched to the PC itself takes it back to the target it had, so it keeps working.
 */
async function answerFor(key: string, allow: boolean) {
  const [phone, list, mode, { phoneSwitch }] = await Promise.all([currentPhone(), answers(), targetMode(), chrome.storage.session.get('phoneSwitch')])
  const name = phone?.key === key ? phone.name : list[key]?.name
  if (!name) return { ok: false }
  await chrome.storage.local.set({ answers: withAnswer(list, { key, name }, allow, Date.now()) })
  if (!allow && phone?.key === key && mode === 'pc' && isTargetMode(phoneSwitch) && phoneSwitch !== 'pc') await setMode(phoneSwitch, false)
  await reviewAccess()
  if (phone?.key === key) void toOffscreen({ to: 'offscreen', type: 'access', key, access: allow ? 'allow' : 'deny' })
  return { ok: true }
}

let notesHeard = false
/** The notification's Allow and Deny, and a click on it. Registered once notifications are allowed. */
function listenToNotes() {
  const notes = chrome.notifications
  if (notesHeard || !notes?.onButtonClicked) return
  notesHeard = true
  notes.onButtonClicked.addListener((id, button) => {
    if (id !== ASK_NOTE) return
    void (async () => {
      const key = await asking()
      if (key) await answerFor(key, button === 0)
    })()
  })
  notes.onClicked.addListener((id) => {
    if (id === ASK_NOTE) void chrome.runtime.openOptionsPage().catch(() => {})
  })
}

/**
 * A new target. From the phone's tray, the PC is refused for a phone this PC said no to (the target stays), and a
 * switch to it is remembered as the phone's own: if the person at the PC says no, the phone goes back to what it had.
 */
async function setMode(mode: TargetMode, fromPhone: boolean): Promise<{ ok: boolean; refused?: 'deny' }> {
  const prev = await targetMode()
  if (fromPhone && mode === 'pc') {
    const [phone, list] = await Promise.all([currentPhone(), answers()])
    if (phone && accessOf(list, phone.key) === 'deny') return { ok: false, refused: 'deny' }
    if (prev !== 'pc') await chrome.storage.session.set({ phoneSwitch: prev })
  } else if (mode !== prev) {
    await chrome.storage.session.remove('phoneSwitch')
  }
  await chrome.storage.local.set({ mode })
  await pushConfig()
  await reviewAccess()
  return { ok: true }
}

// ---- offscreen link ----------------------------------------------------------------------------

let creating: Promise<void> | null = null

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  })
  return contexts.length > 0
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return
  creating ??= (async () => {
    await chrome.storage.session.set({ link: { status: 'starting', url: '', device: null, lan: '', lanFor: null, pairs: [] } satisfies LinkState })
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WEB_RTC'],
      justification: 'Holds the WebRTC connection to the paired phone that sends controller input.',
    })
  })()
    .catch((e: unknown) => {
      if (!/single offscreen/i.test(String(e))) throw e
    })
    .finally(() => { creating = null })
  await creating
}

const toOffscreen = (m: OffscreenRequest) => chrome.runtime.sendMessage(m).catch(() => undefined)

/**
 * What the link document runs with: the controlled tab, the target, and whether the PC target is the whole PC (as
 * ob.Pal Desktop last said, from before this worker started if it hasn't said since). Pushed on every change, and the
 * answer to a link document that has just started, so a new one never falls back to the game keys on a whole PC.
 */
async function currentConfig(): Promise<LinkConfig> {
  const [tabId, mode, wholePc] = await Promise.all([controlledTab(), targetMode(), native.wholePc()])
  return linkConfig(tabId, mode, wholePc)
}

async function pushConfig() {
  await toOffscreen({ to: 'offscreen', type: 'config', ...(await currentConfig()) })
}

// ---- injection ---------------------------------------------------------------------------------

/** The bridge goes into every frame we may access: the tab's own origin via activeTab, all frames with "All sites". */
async function injectBridge(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [BRIDGE_JS], injectImmediately: true })
}

const tellTab = (tabId: number, m: BridgeRequest) => chrome.tabs.sendMessage(tabId, m).catch(() => undefined)

/** A bridge asked whether its tab is controlled. If so, give its frame the MAIN-world page script. */
async function bridgeHello(sender: chrome.runtime.MessageSender) {
  const tabId = sender.tab?.id
  if (tabId === undefined || tabId !== (await controlledTab())) return { active: false }
  await ensureOffscreen()
  const target: chrome.scripting.InjectionTarget = sender.documentId
    ? { tabId, documentIds: [sender.documentId] }
    : { tabId, frameIds: [sender.frameId ?? 0] }
  await chrome.scripting.executeScript({ target, world: 'MAIN', files: [PAGE_JS], injectImmediately: true }).catch(() => {})
  return { active: true }
}

/** With "All sites", new frames and navigations in the controlled tab get a bridge at document_start. */
async function syncRegistration() {
  const [tabId, all] = await Promise.all([controlledTab(), chrome.permissions.contains(ALL_SITES)])
  const want = tabId !== null && all
  const have = (await chrome.scripting.getRegisteredContentScripts({ ids: [REGISTERED_ID] })).length > 0
  if (want && !have) {
    await chrome.scripting.registerContentScripts([{
      id: REGISTERED_ID, js: [BRIDGE_JS], matches: ['<all_urls>'], allFrames: true, matchOriginAsFallback: true,
      runAt: 'document_start', persistAcrossSessions: false,
    }]).catch(() => {})
  } else if (!want && have) {
    await chrome.scripting.unregisterContentScripts({ ids: [REGISTERED_ID] }).catch(() => {})
  }
}

// ---- enable / disable --------------------------------------------------------------------------

async function enableTab(tabId: number) {
  const prev = await controlledTab()
  await ensureOffscreen()
  // Record the tab first: the injected bridges immediately ask whether they are controlled.
  await chrome.storage.session.set({ tab: tabId, frames: null })
  try {
    await injectBridge(tabId)
  } catch (e) {
    await chrome.storage.session.set({ tab: prev === tabId ? null : prev, frames: null })
    throw e
  }
  if (prev !== null && prev !== tabId) {
    await tellTab(prev, { to: 'bridge', type: 'deactivate' })
    await clearBadge(prev)
  }
  await Promise.all([pushConfig(), syncRegistration(), refreshBadge()])
  return { ok: true }
}

async function disableTab(tabId: number) {
  if ((await controlledTab()) === tabId) {
    await chrome.storage.session.set({ tab: null, frames: null })
    await tellTab(tabId, { to: 'bridge', type: 'deactivate' })
    await Promise.all([pushConfig(), syncRegistration(), clearBadge(tabId)])
  }
  return { ok: true }
}

// ---- badge: a dot on the controlled tab's icon, lime while a phone is connected; '!' while one asks for the PC ------

const ASK_BADGE = { text: '!', color: '#FCD34D', ink: '#2A1D02' }

async function clearBadge(tabId: number) {
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
}

async function refreshBadge() {
  const [tabId, link, ask] = await Promise.all([controlledTab(), linkState(), asking()])
  // A phone waiting for an answer shows on every tab (the controlled one's own badge would hide it there).
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ color: ASK_BADGE.color }),
    chrome.action.setBadgeTextColor({ color: ASK_BADGE.ink }),
    chrome.action.setBadgeText({ text: ask ? ASK_BADGE.text : '' }),
  ]).catch(() => {})
  if (tabId === null) return
  const live = link?.status === 'connected'
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color: ask ? ASK_BADGE.color : live ? '#C6FF34' : '#5C5C5C' }),
    chrome.action.setBadgeTextColor({ tabId, color: ask ? ASK_BADGE.ink : live ? '#172100' : '#F4F4F4' }),
    chrome.action.setBadgeText({ tabId, text: ask ? ASK_BADGE.text : '●' }),
  ]).catch(() => {})
}

// ---- messages ----------------------------------------------------------------------------------

async function handle(msg: BgRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'ensure':
      await ensureOffscreen()
      return { ok: true }
    case 'version':
      return { version: chrome.runtime.getManifest().version }
    case 'enable':
      return msg.on ? enableTab(msg.tabId) : disableTab(msg.tabId)
    case 'mode':
      // The link asks on behalf of the phone (its tray); a page of Link's, for the person at the PC.
      return setMode(msg.mode, senderKind({ id: sender.id, url: sender.url, tabId: sender.tab?.id }, SELF) === 'offscreen')
    case 'pc-connect': case 'pc-allow': case 'pc-scope': case 'pc-forget': case 'pc-desktop': case 'pc-macshortcuts': case 'pc-pause': case 'pc-resume': case 'pc-stats':
      return native.handle(msg)
    case 'unpair':
      await toOffscreen({ to: 'offscreen', type: 'unpair' })
      return { ok: true }
    case 'forget':
      // A forgotten phone is a new phone again: its answer for the PC goes with it.
      await chrome.storage.local.set({ answers: withoutAnswer(await answers(), msg.id) })
      await reviewAccess()
      await ensureOffscreen()
      await toOffscreen({ to: 'offscreen', type: 'forget', id: msg.id })
      return { ok: true }
    case 'lan':
      await ensureOffscreen()
      await toOffscreen({ to: 'offscreen', type: 'lan', id: msg.id })
      return { ok: true }
    case 'phone': {
      // Who the link has now: the helper is armed for them only if the person at the PC allowed them.
      await chrome.storage.session.set({ phone: msg.phone })
      await reviewAccess()
      return { access: msg.phone ? accessOf(await answers(), msg.phone.key) : null }
    }
    case 'answer':
      return answerFor(msg.key, msg.allow)
    case 'facts':
      // The popup's badge, asked of the link while the popup is open.
      return (await toOffscreen({ to: 'offscreen', type: 'facts' })) ?? null
    case 'diag':
      return (await toOffscreen({ to: 'offscreen', type: 'diag' })) ?? null
    case 'link':
      await chrome.storage.session.set({ link: msg.link })
      await refreshBadge()
      return { ok: true }
    case 'offscreen-ready': {
      // A fresh link document has no phone yet: nothing may reach the PC until one connects and is allowed.
      await chrome.storage.session.set({ phone: null })
      await reviewAccess()
      const config = await currentConfig()
      // It runs with the whole config (whole PC included), bridges of the controlled tab reconnect their ports to it,
      // and it hears about a text field that already has the focus.
      if (config.tabId !== null) void tellTab(config.tabId, { to: 'bridge', type: 'reconnect' })
      if (native.textField) void toOffscreen({ to: 'offscreen', type: 'text-field', field: native.textField })
      return config
    }
    case 'hello':
      return bridgeHello(sender)
    case 'frames': {
      // Only the controlled tab's top frame speaks for the page.
      const tabId = await controlledTab()
      if (tabId === null || sender.tab?.id !== tabId || (sender.frameId ?? 0) !== 0) return { ok: false }
      await chrome.storage.session.set({ frames: { tab: tabId, count: msg.count, host: msg.host, big: msg.big } })
      return { ok: true }
    }
    case 'rescan': {
      const tabId = await controlledTab()
      if (tabId !== null && sender.tab?.id === tabId) await injectBridge(tabId).catch(() => {})
      return { ok: true }
    }
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
  const msg = parseBgRequest(raw)
  if (!msg) return false
  const kind = senderKind({ id: sender.id, url: sender.url, tabId: sender.tab?.id }, SELF)
  if (!allowedFrom(msg.type, kind)) return false
  handle(msg, sender).then(respond, (e: unknown) => respond({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  return true
})

// PC target: the offscreen link streams action frames over a port (60 Hz while there is input, a heartbeat
// otherwise), which also keeps this worker alive while the helper port is open. Typing comes on the same port, in
// order with the frames.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PC_PAGE_PORT_NAME) {
    // The options page keeps the helper up while it is open, and only then.
    const s = port.sender
    if (senderKind({ id: s?.id, url: s?.url, tabId: s?.tab?.id }, SELF) !== 'extension') return port.disconnect()
    native.pageOpened()
    port.onDisconnect.addListener(() => native.pageClosed())
    return
  }
  if (port.name !== NATIVE_PORT_NAME) return
  const s = port.sender
  if (senderKind({ id: s?.id, url: s?.url, tabId: s?.tab?.id }, SELF) !== 'offscreen') {
    port.disconnect()
    return
  }
  void reviewAccess()
  port.onMessage.addListener((raw: unknown) => {
    const f = parseNativeFrame(raw)
    if (f) return native.frame(f)
    const t = parseNativeText(raw)
    if (t) native.text(t)
  })
})

// ---- tab and permission lifecycle --------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    if (tabId !== (await controlledTab())) return
    await chrome.storage.session.set({ tab: null, frames: null })
    await Promise.all([pushConfig(), syncRegistration()])
  })()
})

// After a reload or navigation the page's scripts are gone: re-bridge it, or let go if access was lost
// (a cross-origin navigation without "All sites").
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return
  void (async () => {
    if (tabId !== (await controlledTab())) return
    try {
      await injectBridge(tabId)
      await refreshBadge()
    } catch {
      await disableTab(tabId)
    }
  })()
})

chrome.permissions.onAdded.addListener(() => {
  void (async () => {
    await syncRegistration()
    const tabId = await controlledTab()
    if (tabId !== null) await injectBridge(tabId).catch(() => {}) // now reaches cross-origin frames too
    listenToNotes() // notifications allowed: a phone's question can come as one
    await reviewAccess() // nativeMessaging granted: the PC target can start
  })()
})
chrome.permissions.onRemoved.addListener(() => void Promise.all([syncRegistration(), reviewAccess()]))
// Keep the link warm from browser start: the pairing code (and, with no internet, the direct code) is ready the
// moment the popup opens, and a remembered phone can connect before anyone clicks anything.
const warm = () => void Promise.all([syncRegistration(), ensureOffscreen().catch(() => {})])
chrome.runtime.onStartup.addListener(warm)
chrome.runtime.onInstalled.addListener(warm)
// Every start of this worker (browser start, or woken after idling): the notification's buttons, and the helper
// reconnected if the target is PC (armed only for a phone the person at the PC allowed).
listenToNotes()
void reviewAccess()
