/** Recovery at the sim page boundary, using the existing glass and action styles. No scene is started twice. */
import { recoverer, RELOAD_KEY, RELOAD_WINDOW_MS, reloadHeld } from '../../ui/recover'
import { GraphicsUnavailable } from './graphics'
import { stopLoading } from './loading'

let terminal = false
let retryTimer: ReturnType<typeof setInterval> | undefined
const storage = () => { try { return sessionStorage } catch { return null } }
const held = () => reloadHeld() || new URLSearchParams(location.search).get('join') === '1'

/** A failed start never proceeds to scene actions or the warm-up reveal. */
export function startScene(start: () => void | Promise<void>) {
  void Promise.resolve().then(start).catch(sceneFailed)
}

/** Graphics failure wins over any model download that finishes later. */
export function sceneFailed(error: unknown) {
  if (terminal) return
  terminal = true
  stopLoading()
  dispatchEvent(new Event('obpal:scene-failed'))
  document.body.classList.add('sim-failed')
  for (const el of document.querySelectorAll<HTMLElement>('.sim-windows, .sim-panel, .panel-dock, #chip, #people, .obpal-chip, .quick-tray, #stage')) {
    el.inert = true
    el.hidden = true
  }
  show(error instanceof GraphicsUnavailable ? 'graphics' : 'scene')
}

/** A failed optional mesh leaves the existing procedural model and its controls available. */
export function modelFailed() {
  if (!terminal) show('model')
}

function show(kind: 'graphics' | 'scene' | 'model') {
  const previous = document.getElementById('sim-recovery')
  if (previous?.dataset.kind === kind) return
  clearInterval(retryTimer)
  const card = document.createElement('section')
  card.id = 'sim-recovery'; card.className = 'sim-recovery glass'; card.dataset.kind = kind
  const heading = document.createElement('h1')
  heading.textContent = document.querySelector('.sim-id h1')?.textContent || document.title.split(' · ')[0]
  const description = document.createElement('p')
  description.className = 'sim-lede'
  description.textContent = document.querySelector('.sim-lede')?.textContent ?? ''
  const message = document.createElement('p')
  message.setAttribute('role', kind === 'model' ? 'status' : 'alert')
  message.textContent = kind === 'graphics'
    ? '3D graphics are unavailable in this browser. Open this scene in a browser or device that supports WebGL.'
    : kind === 'model'
      ? 'A model could not be loaded. The scene can use its simple model.'
      : 'The scene could not be loaded. You can reload this page to try again.'
  const actions = document.createElement('div'); actions.className = 'sim-actions'
  const exit = document.createElement('a'); exit.href = '/sim/'; exit.className = 'kit-action'; exit.textContent = 'Back to sims'
  actions.append(exit)
  card.append(message, actions)
  if (kind !== 'graphics') {
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'kit-action'; retry.textContent = 'Reload scene'
    const explanation = document.createElement('p'); explanation.className = 'sim-lede'; explanation.id = 'sim-retry-help'
    explanation.setAttribute('role', 'status')
    retry.setAttribute('aria-describedby', explanation.id)
    let pending = false, retryMessage = ''
    const update = () => {
      let saved = storage(), recent = 0
      try { recent = Number(saved?.getItem(RELOAD_KEY)) } catch { saved = null }
      const blocked = held(), used = recent > 0 && Date.now() - recent < RELOAD_WINDOW_MS
      retry.disabled = blocked || !saved || used || pending
      const text = blocked ? 'Reload is unavailable while this scene is paired or shared.'
        : used ? 'This page has already been retried. Try again later, or return to Sims.'
          : !saved ? 'Reload is unavailable because this browser cannot keep the retry limit.'
            : retryMessage || 'Reload starts a new scene. This page can retry once in ten minutes.'
      if (explanation.textContent !== text) explanation.textContent = text
    }
    const recover = recoverer({ now: () => Date.now(), get storage() { return storage() }, held,
      reachable: async () => {
        try { return (await fetch(location.href, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(4000) })).ok } catch { return false }
      }, reload: () => location.reload(),
    })
    retry.onclick = async () => {
      if (pending) return
      pending = true; update()
      if (!await recover()) {
        pending = false
        retryMessage = 'The page could not be reloaded. Try again, or return to Sims.'
        update()
      }
    }
    update(); retryTimer = setInterval(update, 500)
    actions.append(retry); card.append(explanation)
  }
  if (kind !== 'model') card.prepend(heading, description)
  if (previous) previous.replaceWith(card)
  else document.body.append(card)
  // Move focus out of controls that have no functioning scene, to the reliable exit.
  if (kind !== 'model') exit.focus({ preventScroll: true })
}
