/** Immediate audio delivery, clock replies and screen controls for the shared studio. */
import { readMusic, scaleNote } from '../../music'
import type { SimScene } from '../scene'
import type { Stage } from './stage'
import type { StudioLogic } from './studio'
import { StudioSound } from './studio.sound'
import { StudioPlayers } from './studio.players'
import { html, setMarkup } from '../../ui/markup'
import { CapsuleGauge } from '../../ui/kit/gauge'
import { DetentSlider } from '../../ui/kit/slider'
import { toggle } from '../../ui/kit/toggle'
import { quickAction } from '../../ui/quick-actions'
import { resolveStrike } from '../../music-space'
import { rail } from '../vr/intent'

export function attachStudio(sim: SimScene, logic: StudioLogic, stage: Stage, position: (seat: number) => readonly [number, number, number]) {
  const sound = new StudioSound(position)
  logic.onControl = (seat, e) => { if (e.op === 'hit') sound.hit(seat, e.n, e.v); else sound.note(seat, e.n, e.v, seat === 6, true) }
  const players = new StudioPlayers(n => sound.stop(n))
  const samples: { ms: number; uncertainty: number; seat: number; seq: number }[] = []
  const frameTimes: number[] = []
  let peak = 0, lastFrame = 0
  // The studio's sound card: start and mute with the room's output beside it, the volume with its stops, and reduced sound.
  const panel = document.createElement('section'); panel.className = 'studio-audio'; panel.setAttribute('aria-labelledby', 'studio-audio-h')
  setMarkup(panel, html`<header class="kit-card-head"><span class="kit-card-n"></span><h2 class="kit-card-title" id="studio-audio-h">Sound</h2><span class="kit-card-aside"><button type="button" class="kit-action" id="studio-start">Start sound</button></span></header><small role="status">Tap here to hear the room. Start with your speakers low.</small>`)
  const meter = new CapsuleGauge({ label: 'Studio output', value: 0 })
  panel.querySelector('.kit-card-aside')!.prepend(meter.el)
  let muted = false, starting = false
  const volume = new DetentSlider({
    label: 'Studio volume', min: 0, max: 80, step: 1, value: 65,
    detents: [{ value: 0, label: 'Off' }, { value: 40, label: 'Soft' }, { value: 65, label: 'Room' }, { value: 80, label: 'Max' }],
    onInput: v => { if (!muted) sound.setVolume(v / 100) },
  })
  let quiet = false
  try { quiet = localStorage.getItem('obpal.sim.reduced') === '1' } catch { /* private browsing */ }
  sound.setReduced(quiet)
  const reduced = toggle({ label: 'Reduced sound', checked: quiet, onChange: on => { sound.setReduced(on); try { localStorage.setItem('obpal.sim.reduced', on ? '1' : '0') } catch { /* private browsing */ } } })
  panel.querySelector('header')!.after(volume.el, reduced)
  // The panel keeps a place for sound; before it did, the card followed the device's description.
  const home = document.querySelector('[data-sound-home]')
  if (home) home.append(panel)
  else document.getElementById('dev-blurb')!.after(panel)
  const start = panel.querySelector<HTMLButtonElement>('#studio-start')!, status = panel.querySelector('small')!
  // The same switch in the quick-actions tray: on while the room plays.
  const offer = () => quickAction({
    id: 'sound', label: !sound.running ? 'Start sound' : muted ? 'Unmute sound' : 'Mute sound', hint: 'The studio’s sound', icon: sound.running && !muted ? 'sound' : 'mute',
    stay: true, pressed: () => sound.running && !muted, run: () => start.click(),
  })
  const startSound = async () => {
    if (starting || sound.running) return
    starting = true
    try { await sound.start(); start.textContent = 'Mute'; status.textContent = 'Sound is on · scan to join the room' }
    catch { status.textContent = 'Sound could not start. Tap Start sound to try again.' }
    finally { starting = false; offer() }
  }
  start.onclick = () => {
    if (!sound.running) { void startSound(); return }
    muted = !muted; sound.setVolume(muted ? 0 : volume.value / 100); start.textContent = muted ? 'Unmute' : 'Mute'
    offer()
  }
  offer()
  const firstInteraction = (e: Event) => { if (!(e.target as HTMLElement).closest('#studio-start, [data-quick="sound"]')) void startSound() }
  document.addEventListener('pointerdown', firstInteraction, { once: true })
  document.addEventListener('keydown', firstInteraction, { once: true })
  logic.onHome = n => sound.stop(n)
  const seatOf = (who: string) => sim.nodes.findIndex(n => n.id === sim.claims.held(who))
  const blockedAt = new Map<string, number>()
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
      if (e.aim) {
        // Resolve the event snapshot, not the latest rendered aim. The player owns voices;
        // the target chooses their instrument and spatial bus.
        const target = resolveStrike(e.aim, e.scope!, sim.control.scope(who.id), seat, n => {
          const holder = sim.claims.holder(sim.nodes[n].id)
          return !holder || holder === who.id
        }, rail(stage.view.presence ? { yaw: stage.view.presence.controlFrame.yaw, heading: 0, immersive: stage.view.presence.immersive } : undefined))
        if (!target) {
          if (performance.now() - (blockedAt.get(who.id) ?? -Infinity) > 1500) {
            sim.remote.feedback({ toast: 'That instrument is in use · aim at a free instrument' }, who.id)
            blockedAt.set(who.id, performance.now())
          }
          return
        }
        at = target.melodic ? sound.note(seat, target.n, e.v, target.seat === 6, true, target.seat) : sound.hit(seat, target.n, e.v, target.seat)
        logic.play(target.seat, { ...e, op: target.melodic ? 'on' : 'hit', n: target.n }, target.surface)
      } else {
        const drum = seat === 1 || seat === 7 ? (e.n >= 9 ? e.n : 9 + e.n % 4) : e.n
        at = seat >= 3 && seat <= 6 ? sound.note(seat, scaleNote(e.n, 0, 4, 'pentatonic'), e.v, seat === 6, true) : sound.hit(seat, drum, e.v)
        logic.play(seat, { ...e, n: drum })
      }
    } else if (e.op === 'on') {
      at = seat < 3 || seat === 7 ? sound.hit(seat, seat === 1 || seat === 7 ? 9 + e.n % 4 : e.n % 9, e.v) : sound.note(seat, e.n, e.v)
      logic.play(seat, e)
    } else if (e.op === 'air') { at = sound.air(seat, e.n, e.v); logic.play(seat, e) }
    if (at !== null && e.at > 0 && e.op !== 'air') {
      const ms = performance.timeOrigin + performance.now() - e.at + Math.max(0, at - sound.context!.currentTime) * 1000
      if (ms >= -e.uncertainty && ms < 10_000) { samples.push({ ms: Math.max(0, ms), uncertainty: e.uncertainty, seat, seq: e.seq }); if (samples.length > 8192) samples.shift() }
    }
  })
  sim.remote.on('leave', p => { players.drop(p.id); blockedAt.delete(p.id) })
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
