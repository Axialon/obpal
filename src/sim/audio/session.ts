/**
 * Page controls and lifetime; feedback delivery stays with the sim's existing addressed transport. The controls are a
 * card: its header with the button that starts, mutes and unmutes the sound, and a level slider with three stops, Off
 * (muted), Reduced and Full, that the button and the slider keep in step.
 */
import { SimSound, type Rumble } from './engine'
import { profileOf } from './profiles'
import { DetentSlider } from '../../ui/kit/slider'
import { ICONS } from '../../ui/icons'
import { html, setMarkup } from '../../ui/markup'
import { quickAction } from '../../ui/quick-actions'
import '../../styles/sound.css'

/** The level slider's stops, in order: 0 is muted, 1 reduced, 2 full. */
const LEVELS = ['Off', 'Reduced', 'Full']

export function mountSound(id: string, rumble: Rumble, panel = document.querySelector('.sim-panel')) {
  const sound = new SimSound(profileOf(id), rumble)
  try { sound.muted = localStorage.getItem('obpal.sim.muted') === '1'; sound.reduced = localStorage.getItem('obpal.sim.reduced') === '1' } catch { /* private browsing */ }
  const row = document.createElement('section'); row.className = 'sim-sound'; row.setAttribute('aria-labelledby', 'sim-sound-h')
  const head = document.createElement('header'); head.className = 'kit-card-head'
  setMarkup(head, html`<span class="kit-card-n"></span><h2 class="kit-card-title" id="sim-sound-h">Sound</h2><span class="kit-card-aside"></span>`)
  const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'kit-action'; mute.id = 'sim-sound'
  head.querySelector('.kit-card-aside')!.append(mute)
  const level = () => sound.muted ? 0 : sound.reduced ? 1 : 2
  const slider = new DetentSlider({
    label: 'Sound level', min: 0, max: 2, step: 1, value: level(), snap: 0.5,
    detents: LEVELS.map((label, value) => ({ value, label })),
    onChange: (v) => {
      if (v > 0 && sound.reduced !== (v === 1)) sound.setReduced(v === 1)
      sound.setMuted(v === 0); persist()
      if (v > 0) void start()
      refresh()
    },
  })
  const status = document.createElement('small'); status.setAttribute('role', 'status')
  row.append(head, slider.el, status)
  // A panel may keep a place for it; it comes back there from first person.
  ;(panel?.querySelector('[data-sound-home]') ?? panel)?.append(row)
  const refresh = () => {
    const words = sound.muted ? 'Unmute sound' : sound.running ? 'Mute sound' : 'Start sound'
    setMarkup(mute, html`${ICONS[sound.muted ? 'mute' : 'sound']}<span>${words}</span>`)
    mute.setAttribute('aria-pressed', String(sound.muted))
    slider.value = level()
    // The same switch in the quick-actions tray: on while the sound plays.
    quickAction({ id: 'sound', group: 'system', label: words, hint: 'The sim’s sound', icon: sound.muted || !sound.running ? 'mute' : 'sound', stay: true, pressed: () => sound.running && !sound.muted, run: () => mute.click() })
  }
  const persist = () => { try { localStorage.setItem('obpal.sim.muted', sound.muted ? '1' : '0'); localStorage.setItem('obpal.sim.reduced', sound.reduced ? '1' : '0') } catch { /* private browsing */ } }
  const start = async () => { try { await sound.start(); status.textContent = ''; refresh() } catch { status.textContent = 'Tap Start sound to try again.' } }
  // Any press starts the sound, but for the sound switches' own (this card's, the quick-actions tray's): they decide.
  const gesture = (e: Event) => { if (!sound.running && !sound.muted && !mute.contains(e.target as Node) && !(e.target as Element | null)?.closest?.('[data-quick="sound"]')) void start() }
  document.addEventListener('pointerdown', gesture); document.addEventListener('keydown', gesture)
  mute.onclick = () => { sound.setMuted(sound.running ? !sound.muted : false); persist(); void start(); refresh() }
  const hidden = () => { if (document.hidden) { sound.stop(); sound.gate.clear(); void sound.context?.suspend() } }
  document.addEventListener('visibilitychange', hidden)
  addEventListener('pagehide', e => {
    sound.stop()
    if (e.persisted) { void sound.context?.suspend(); return }
    sound.dispose(); void sound.context?.close()
    document.removeEventListener('pointerdown', gesture); document.removeEventListener('keydown', gesture); document.removeEventListener('visibilitychange', hidden)
  })
  Object.assign(window, { __simAudio: sound })
  refresh()
  return sound
}
