/**
 * Service worker: message routing and per-tab enablement.
 *  - Keeps the offscreen link document (the ob.Pal Remote) alive while it is needed.
 *  - "Control this tab" injects the bridge into every permitted frame of that tab; each bridge then says hello
 *    and gets the MAIN-world page script injected into its frame. Only one tab is controlled at a time.
 *  - With the optional "All sites" permission it also registers the bridge for new frames and navigations.
 *  - State: target mode in storage.local; controlled tab and link status in storage.session (the popup reads both).
 */
import { DEFAULT_MODE, isTargetMode, type TargetMode } from './shared/constants'
import {
  allowedFrom, parseBgRequest, parseLink, senderKind,
  type BgRequest, type BridgeRequest, type LinkState, type OffscreenRequest,
} from './shared/messages'

const OFFSCREEN_PATH = 'offscreen.html'
const BRIDGE_JS = 'bridge.js'
const PAGE_JS = 'page.js'
const REGISTERED_ID = 'obpal-link-bridge'
const ALL_SITES: chrome.permissions.Permissions = { origins: ['<all_urls>'] }
const SELF = { id: chrome.runtime.id, origin: chrome.runtime.getURL('').replace(/\/$/, '') }

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
    await chrome.storage.session.set({ link: { status: 'starting', url: '', device: null } satisfies LinkState })
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

async function pushConfig() {
  const [tabId, mode] = await Promise.all([controlledTab(), targetMode()])
  await toOffscreen({ to: 'offscreen', type: 'config', tabId, mode })
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

// ---- badge: a dot on the controlled tab's icon, lime while a phone is connected -------------------

async function clearBadge(tabId: number) {
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
}

async function refreshBadge() {
  const tabId = await controlledTab()
  if (tabId === null) return
  const live = (await linkState())?.status === 'connected'
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color: live ? '#C6FF34' : '#5C5C5C' }),
    chrome.action.setBadgeTextColor({ tabId, color: live ? '#172100' : '#F4F4F4' }),
    chrome.action.setBadgeText({ tabId, text: '●' }),
  ]).catch(() => {})
}

// ---- messages ----------------------------------------------------------------------------------

async function handle(msg: BgRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'ensure':
      await ensureOffscreen()
      return { ok: true }
    case 'enable':
      return msg.on ? enableTab(msg.tabId) : disableTab(msg.tabId)
    case 'mode':
      await chrome.storage.local.set({ mode: msg.mode })
      await pushConfig()
      return { ok: true }
    case 'unpair':
      await toOffscreen({ to: 'offscreen', type: 'unpair' })
      return { ok: true }
    case 'link':
      await chrome.storage.session.set({ link: msg.link })
      await refreshBadge()
      return { ok: true }
    case 'offscreen-ready': {
      const [tabId, mode] = await Promise.all([controlledTab(), targetMode()])
      // A fresh link document: bridges of the controlled tab reconnect their ports to it.
      if (tabId !== null) void tellTab(tabId, { to: 'bridge', type: 'reconnect' })
      return { tabId, mode }
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
  })()
})
chrome.permissions.onRemoved.addListener(() => void syncRegistration())
chrome.runtime.onStartup.addListener(() => void syncRegistration())
chrome.runtime.onInstalled.addListener(() => void syncRegistration())
