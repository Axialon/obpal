/** Immediate audio delivery, clock replies and screen controls for the shared studio. */
import { readMusic, scaleNote } from '../../music'
import type { SimScene } from '../scene'
import type { Stage } from './stage'
import type { StudioLogic } from './studio'
import { StudioSound } from './studio.sound'
import { StudioPlayers } from './studio.players'
import { html, setMarkup } from '../../ui/markup'

export function attachStudio(sim: SimScene, logic: StudioLogic, stage: Stage, position: (seat: number) => readonly [number, number, number]) {
  const sound = new StudioSound(position)
  const players = new StudioPlayers(n => sound.stop(n))
  const samples: { ms: number; uncertainty: number; seat: number; seq: number }[] = []
  const frameTimes: number[] = []
  let peak = 0, lastFrame = 0
  const panel = document.createElement('div'); panel.className = 'studio-audio'
  setMarkup(panel, html`<button type="button" id="studio-start">Start sound</button><meter min="0" max="1" value="0" aria-label="Studio output"></meter><label>Volume<input type="range" min="0" max="80" value="65" aria-label="Studio volume"></label><small role="status">Tap here to hear the room. Start with your speakers low.</small>`)
  document.getElementById('dev-blurb')!.after(panel)
  const reducedLabel = document.createElement('label'), reduced = document.createElement('input')
  reduced.type = 'checkbox'
  try { reduced.checked = localStorage.getItem('obpal.sim.reduced') === '1' } catch { /* private browsing */ }
  sound.setReduced(reduced.checked)
  reducedLabel.append(reduced, ' Reduced sound'); panel.append(reducedLabel)
  reduced.onchange = () => { sound.setReduced(reduced.checked); try { localStorage.setItem('obpal.sim.reduced', reduced.checked ? '1' : '0') } catch { /* private browsing */ } }
  const start = panel.querySelector<HTMLButtonElement>('button')!, status = panel.querySelector('small')!, meter = panel.querySelector('meter')!
  let muted = false, starting = false
  const startSound = async () => {
    if (starting || sound.running) return
    starting = true
    try { await sound.start(); start.textContent = 'Mute'; status.textContent = 'Sound is on · scan to join the room' }
    catch { status.textContent = 'Sound could not start. Tap Start sound to try again.' }
    finally { starting = false }
  }
  start.onclick = () => {
    if (!sound.running) { void startSound(); return }
    muted = !muted; sound.setVolume(muted ? 0 : Number(panel.querySelector('input')!.value) / 100); start.textContent = muted ? 'Unmute' : 'Mute'
  }
  const firstInteraction = (e: Event) => { if (!(e.target as HTMLElement).closest('#studio-start')) void startSound() }
  document.addEventListener('pointerdown', firstInteraction, { once: true })
  document.addEventListener('keydown', firstInteraction, { once: true })
  panel.querySelector('input')!.oninput = e => { if (!muted) sound.setVolume(Number((e.target as HTMLInputElement).value) / 100) }
  logic.onHome = n => sound.stop(n)
  const seatOf = (who: string) => sim.nodes.findIndex(n => n.id === sim.claims.held(who))
  sim.remote.on('value', ({ id, v }, who) => {
    const now = performance.timeOrigin + performance.now()
    if (id === 'music.sync' && typeof v === 'number' && Number.isFinite(v)) {
      sim.remote.setValues({ 'music.sync': JSON.stringify({ at: v, host: now }) }, who.id); return
    }
    if (id !== 'music.event') return
    const e = readMusic(v), seat = seatOf(who.id)
    if (!e || document.hidden || !players.accept(who.id, seat, e, performance.now())) return
    let at: number | null = null
    if (e.op === 'stop') sound.stop(seat)
    else if (e.op === 'off') sound.off(seat, e.n)
    else if (e.op === 'bend') sound.bend(seat, e.x)
    else if (e.op === 'hit') {
      const drum = seat === 1 || seat === 7 ? (e.n >= 9 ? e.n : 9 + e.n % 4) : e.n
      at = seat >= 3 && seat <= 6 ? sound.note(seat, scaleNote(e.n, 0, 4, 'pentatonic'), e.v, seat === 6, true) : sound.hit(seat, drum, e.v)
      logic.play(seat, { ...e, n: drum })
    } else if (e.op === 'on') {
      at = seat < 3 || seat === 7 ? sound.hit(seat, seat === 1 || seat === 7 ? 9 + e.n % 4 : e.n % 9, e.v) : sound.note(seat, e.n, e.v)
      logic.play(seat, e)
    } else if (e.op === 'air') { at = sound.air(seat, e.n, e.v); logic.play(seat, e) }
    if (at !== null && e.at > 0 && e.op !== 'air') {
      const ms = performance.timeOrigin + performance.now() - e.at + Math.max(0, at - sound.context!.currentTime) * 1000
      if (ms >= -e.uncertainty && ms < 10_000) { samples.push({ ms: Math.max(0, ms), uncertainty: e.uncertainty, seat, seq: e.seq }); if (samples.length > 8192) samples.shift() }
    }
  })
  sim.remote.on('leave', p => players.drop(p.id))
  sim.remote.on('mode', (_mode, p) => players.drop(p.id))
  sim.remote.on('claim', () => players.check(performance.now(), seatOf))
  const watchdog = setInterval(() => players.check(performance.now(), seatOf), 100)
  document.addEventListener('visibilitychange', () => { if (document.hidden) { players.silence(); sound.stop() } })
  const raf = (now: number) => {
    if (lastFrame && !document.hidden) { frameTimes.push(now - lastFrame); if (frameTimes.length > 3600) frameTimes.shift() }
    lastFrame = now
    const level = sound.meter(); peak = Math.max(peak, level); meter.value = level
    requestAnimationFrame(raf)
  }
  requestAnimationFrame(raf)
  Object.assign(window, { __studio: { sound, samples, frameTimes, peak: () => peak, gfx: () => stage.view.gfx() } })
  addEventListener('pagehide', e => {
    players.silence(); sound.stop()
    if (e.persisted) void sound.context?.suspend()
    else { clearInterval(watchdog); void sound.close() }
  })
}
