/** Page controls and lifetime; feedback delivery stays with the sim's existing addressed transport. */
import { SimSound, type Rumble } from './engine'
import { profileOf } from './profiles'

export function mountSound(id: string, rumble: Rumble, panel = document.querySelector('.sim-panel')) {
  const sound = new SimSound(profileOf(id), rumble)
  try { sound.muted = localStorage.getItem('obpal.sim.muted') === '1'; sound.reduced = localStorage.getItem('obpal.sim.reduced') === '1' } catch { /* private browsing */ }
  const row = document.createElement('div'); row.className = 'sim-sound'
  const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'btn'; mute.id = 'sim-sound'
  const label = document.createElement('label'), reduced = document.createElement('input')
  reduced.type = 'checkbox'; reduced.checked = sound.reduced; label.append(reduced, ' Reduced sound')
  const status = document.createElement('small'); status.setAttribute('role', 'status')
  row.append(mute, label, status); panel?.append(row)
  const refresh = () => { mute.textContent = sound.muted ? 'Unmute sound' : sound.running ? 'Mute sound' : 'Start sound'; mute.setAttribute('aria-pressed', String(sound.muted)) }
  const persist = () => { try { localStorage.setItem('obpal.sim.muted', sound.muted ? '1' : '0'); localStorage.setItem('obpal.sim.reduced', sound.reduced ? '1' : '0') } catch { /* private browsing */ } }
  const start = async () => { try { await sound.start(); status.textContent = ''; refresh() } catch { status.textContent = 'Tap Start sound to try again.' } }
  const gesture = (e: Event) => { if (!sound.running && !sound.muted && e.target !== mute) void start() }
  document.addEventListener('pointerdown', gesture); document.addEventListener('keydown', gesture)
  mute.onclick = () => { sound.setMuted(sound.running ? !sound.muted : false); persist(); void start(); refresh() }
  reduced.onchange = () => { sound.setReduced(reduced.checked); persist() }
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
