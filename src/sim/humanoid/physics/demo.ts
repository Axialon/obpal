/** Experimental physics preview. Rendering and capture stay here; Rapier and all targets live in the worker. */
import '../../../styles/base.css'
import '../../../styles/sim.css'
import '../../../styles/humanoid.css'
import { BodyInput, type Layout } from '@obpal/host'
import { Controller, encodeBody, type BodyState } from '@obpal/core'
import { family } from '../../../family'
import { applyTheme, initialTheme, themeById } from '../../../ui/themes'
import { mountMarks } from '../../../ui/icons'
import { mountTopBar } from '../../../landing/topbar'
import { mountQuick } from '../../../ui/quick'
import { mountBodyCapture, toggleBodyCapture } from '../../../ui/body-capture'
import { cameraWorker } from '../../../ui/camera-worker'
import { createStage } from '../../devices/stage'
import { Seats } from '../../devices/seats'
import { startSimScene, type SimScene } from '../../scene'
import { LocalControls } from '../../local-controls'
import { mountSimPanels, numberSections } from '../../ui/panels'
import { mountSound } from '../../audio/session'
import { startScene } from '../../kit/recovery'
import { KEEL } from '../profile'
import { Rig, arena } from '../rig'
import { Retargeter } from '../retarget'
import { PRESETS, presetPose, type Preset } from '../controls'
import { CALIBRATION_KEY, parseCalibration } from '../calibration'
import { lightArena, quietHorizon, soleShadow } from '../lighting'
import type { ActorId, PushClass, PushDirection } from './world'
import type { PhysicsCommand, PhysicsState } from './world.worker'

const percentile = (values: readonly number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0
startScene(async () => {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
  applyTheme(initialTheme()); mountMarks(); mountTopBar(); mountQuick(); family.watchTheme()
  mountSimPanels('humanoid-physics', 'Controls'); numberSections()
  let ready = false, failed = false, count: 1 | 2 = 1, selected = 0, captureSeat = 0, captureActive = false
  const stage = createStage($<HTMLCanvasElement>('stage'), initialTheme(), { maxDpr: 1, portraitFraming: true, ready: () => ready || failed })
  stage.renderer.shadowMap.enabled = false
  lightArena(stage); stage.scene.add(arena())
  const framing = { target: [0, .9, 0] as [number, number, number], wide: [3.8, 2.7, -5.7] as [number, number, number],
    tall: [3.5, 3, -6.5] as [number, number, number], radius: 2, min: 3, max: 16 }
  stage.frame(framing); quietHorizon(stage)
  addEventListener('bb-theme', e => { stage.setTheme(themeById((e as CustomEvent<{ theme: string }>).detail.theme)); quietHorizon(stage) })
  addEventListener('obpal:panels', () => { stage.resize(); stage.frame(framing); quietHorizon(stage) })
  const actors = [0, 1].map(i => {
    const rig = new Rig(KEEL, i), retarget = new Retargeter(KEEL)
    stage.scene.add(rig.root); rig.root.visible = false; void rig.load()
    const shadows = KEEL.chains.filter(c => c.group === 'legs').map(c => {
      const mesh = soleShadow(); stage.scene.add(mesh); mesh.visible = false; return { joint: c.end, mesh }
    })
    return { id: `seat${i + 1}` as ActorId, name: `Keel ${i + 1}`, rig, retarget, shadows, owner: '', feed: '',
      body: null as ReturnType<Retargeter['step']> | null, preset: null as Preset | null, presetAt: 0, loadedFeet: new Set<string>() }
  })
  const worker = cameraWorker('humanoidPhysics')
  let sequence = 0, advanceRequest = 0, busy = false, pendingSeconds = 0, lastNow = 0, current: PhysicsState | null = null
  const pending = new Map<number, { resolve: (state: PhysicsState) => void; reject: (error: Error) => void }>()
  const workTimesMs: number[] = [], tickTimesMs: number[] = [], workerTimesMs: number[] = [], frameIntervalsMs: number[] = []
  const budgetWorkTimesMs: number[] = [], budgetWorker: { workMs: number; seconds: number }[] = []
  let workerWorkMs = 0, workerAdvancedSeconds = 0, workBegin = 0, pendingEventWorkMs = 0, droppedSeconds = 0, droppedStart = 0, sampleOrigin = performance.now(), degraded = false, measure = false
  const retain = (list: number[], values: readonly number[]) => { list.push(...values); if (list.length > 100000) list.splice(0, list.length - 100000) }
  function fail(message: string) {
    if (failed) return
    failed = true; ready = false; busy = false
    $('physics-status').textContent = 'Physics unavailable'
    $('physics-budget').textContent = `Rapier could not continue: ${message}. Open Humanoid practice to continue.`
    for (const id of ['physics-push', 'physics-stance', 'physics-reset', 'physics-two', 'physics-body']) $<HTMLButtonElement>(id).disabled = true
    for (const p of pending.values()) p.reject(new Error(message))
    pending.clear(); worker.terminate()
  }
  worker.onerror = event => fail(event.message || 'Worker failed')
  worker.onmessage = (event: MessageEvent<PhysicsState | { kind: 'error'; request: number; message: string }>) => {
    const eventBegin = performance.now()
    const s = event.data
    if (s.kind === 'error') { fail(s.message); return }
    current = s
    if (s.request === advanceRequest) busy = false
    if (s.advancedSeconds > 0) { budgetWorker.push({ workMs: s.workerWorkMs, seconds: s.advancedSeconds }); if (budgetWorker.length > 120) budgetWorker.shift() }
    if (measure) { retain(tickTimesMs, s.tickTimesMs); retain(workerTimesMs, [s.workerWorkMs]); workerWorkMs += s.workerWorkMs; workerAdvancedSeconds += s.advancedSeconds }
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i], frames = s.frames[a.id]
      a.rig.root.visible = !!frames
      if (frames) a.rig.poseWorld(frames)
    }
    const p = pending.get(s.request)
    if (p) { pending.delete(s.request); p.resolve(s) }
    pendingEventWorkMs += performance.now() - eventBegin
  }
  type CommandInput = PhysicsCommand extends infer C ? C extends PhysicsCommand ? Omit<C, 'request'> : never : never
  function send(command: CommandInput): Promise<PhysicsState> {
    if (failed) return Promise.reject(new Error('Physics unavailable'))
    const request = ++sequence
    const promise = new Promise<PhysicsState>((resolve, reject) => pending.set(request, { resolve, reject }))
    worker.postMessage({ ...command, request })
    return promise
  }
  let sim: SimScene | null = null, seats: Seats | null = null
  const sound = mountSound('dog', (strong, weak, ms, who) => sim?.remote.rumble(strong, weak, ms, who))
  numberSections()
  const nodes = () => actors.slice(0, count).map(a => ({ id: a.id, name: a.name, kind: 'slot' as const, group: 'Actors' }))
  const tray = [...PRESETS.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), type: 'button' as const })),
    { id: 'push', label: 'Push', type: 'button' as const }, { id: 'reset', label: 'Reset', type: 'button' as const }, { id: 'stand', label: 'Stance', type: 'button' as const }]
  const layout: Layout = { v: 1, controllers: [Controller.trackpad], utilities: ['touch.trackpad', 'camera.body'], tray }
  const capture = mountBodyCapture({ timeOrigin: performance.now(), beforeOpen: () => {
    captureSeat = selected; captureActive = true; sim?.take(actors[captureSeat].id, 'host', true); return true
  }, closed: () => { captureActive = false; sim?.release('host') } })
  const local = new LocalControls({ id: 'humanoid-physics', canvas: stage.renderer.domElement, units: () => nodes(), tray,
    phone: () => $('chip-invite').click(), controllerWindow: () => { if (sim?.remote.pairingUrl) window.open(sim.remote.pairingUrl, '_blank', 'noopener') },
    orbit: enabled => { stage.controls.enabled = enabled } })
  void startSimScene({ appName: 'ob.Pal humanoid physics', layout, nodes: nodes(), approval: false,
    howTo: () => 'Push tests balance · Reset rebuilds the arena · BODY follows with arms and head',
    joined: participant => { if (participant.capability !== 'watch') { const a = actors.slice(0, count).find(a => !sim?.claims.holder(a.id)); if (a) sim?.take(a.id, participant.id) } },
  }).then(s => { sim = s; seats = new Seats(s.remote, layout); if (captureActive) s.take(actors[captureSeat].id, 'host') }).catch(error => {
    $('seat-owner').textContent = `Phone pairing unavailable: ${error instanceof Error ? error.message : 'connection failed'}. Local controls remain available.`
  })
  const injected = new Map<number, BodyInput>()
  const testing = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && new URLSearchParams(location.search).get('test') === 'humanoid-physics'
  function choose(index: number) {
    selected = Math.min(count - 1, index)
    document.querySelectorAll<HTMLButtonElement>('[data-seat]').forEach(button => { button.hidden = Number(button.dataset.seat) >= count; button.setAttribute('aria-pressed', String(Number(button.dataset.seat) === selected)) })
  }
  function clearCapture() { for (const a of actors) { a.retarget.reset(); a.body = null; a.preset = null; a.feed = ''; a.loadedFeet.clear() }; injected.clear() }
  async function reset() {
    ready = false; pendingSeconds = 0; droppedSeconds = 0; clearCapture()
    try { await send({ kind: 'reset' }); ready = true; lastNow = 0; sim?.log('Arena reset') }
    catch (error) { fail(error instanceof Error ? error.message : 'Reset failed') }
  }
  async function actorCount(next: 1 | 2) {
    if (next === 2 && degraded) return
    ready = false; count = next; pendingSeconds = 0; droppedSeconds = 0; clearCapture(); choose(selected)
    $<HTMLInputElement>('physics-two').checked = next === 2; $('physics-actor2').hidden = next !== 2
    sim?.setNodes(nodes())
    try { await send({ kind: 'init', count }); ready = true; lastNow = 0; sim?.log(`${count} actor arena started`) }
    catch (error) { fail(error instanceof Error ? error.message : 'Arena failed') }
  }
  async function push(actorId: ActorId = actors[selected].id, magnitude: PushClass = 'A', direction: PushDirection = 'toe') {
    if (!ready) return
    await send({ kind: 'push', actorId, magnitude, direction }); sim?.log(`${actorId}: class ${magnitude} ${direction} push`)
  }
  async function stance(actorId: ActorId = actors[selected].id) {
    const a = actors.find(a => a.id === actorId)!
    a.preset = null; a.body = null; a.retarget.reset(); injected.delete(actors.indexOf(a))
    if (captureSeat === actors.indexOf(a)) captureActive = false
    await send({ kind: 'stance', actorId }); sim?.log(`${actorId}: stance`)
  }
  const action = (id: string, actor: typeof actors[number]) => {
    if (id === 'push') void push(actor.id).catch(error => fail(String(error)))
    else if (id === 'reset' || id === 'home') void reset()
    else if (id === 'stand') void stance(actor.id).catch(error => fail(String(error)))
    else if (PRESETS.includes(id as Preset)) { actor.preset = id as Preset; actor.presetAt = performance.now() }
  }
  document.querySelectorAll<HTMLButtonElement>('[data-seat]').forEach(button => { button.onclick = () => choose(Number(button.dataset.seat)) })
  $('physics-push').onclick = () => action('push', actors[selected])
  $('physics-reset').onclick = () => void reset()
  $('physics-stance').onclick = () => action('stand', actors[selected])
  $('physics-body').onclick = () => toggleBodyCapture()
  $<HTMLInputElement>('physics-two').onchange = event => { void actorCount((event.target as HTMLInputElement).checked ? 2 : 1) }
  addEventListener('keydown', event => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || (event.target as Element)?.closest('input,select,textarea,button,a,[contenteditable]')) return
    if (event.code === 'KeyP') action('push', actors[selected])
    else if (event.code === 'KeyR') void reset()
    else if (event.code === 'Space') { event.preventDefault(); action('stand', actors[selected]) }
  })
  document.addEventListener('visibilitychange', () => { lastNow = 0; pendingSeconds = 0 })
  let uiAt = 0, budgetAt = 0
  stage.onFrame = (t, dt) => {
    workBegin = performance.now()
    const now = t * 1000
    if (!ready || failed) { lastNow = 0; return }
    const elapsed = lastNow ? Math.max(0, (now - lastNow) / 1000) : 1 / 60
    if (measure && lastNow) retain(frameIntervalsMs, [(now - lastNow)])
    lastNow = now; pendingSeconds += elapsed
    const inputs = seats?.read(now), localFrames = local.frames(n => { const owner = sim?.claims.holder(actors[n].id); return !!owner && owner !== 'host' }, dt), camera = capture.read(now)
    for (const [i, a] of actors.slice(0, count).entries()) {
      const owner = sim?.claims.holder(a.id) ?? (localFrames.has(i) || captureActive && captureSeat === i ? 'host' : '')
      if (owner !== a.owner) {
        const previous = a.owner; a.owner = owner; a.retarget.reset(); a.preset = null
        if (previous) void send({ kind: 'loss', actorId: a.id }).catch(error => fail(String(error)))
        const participant = sim?.remote.participants.find(p => p.id === owner), key = `${CALIBRATION_KEY}${owner === 'host' ? 'local' : participant?.fp ?? participant?.pair ?? owner}`
        try { a.retarget.data = parseCalibration(localStorage.getItem(key), KEEL) } catch { a.retarget.data = parseCalibration(null, KEEL) }
      }
      const input = owner && owner !== 'host' ? inputs?.get(owner) : localFrames.get(i)
      for (const id of input?.presses ?? []) action(id, a)
      for (const [bit, item] of tray.entries()) if ((input?.padPressed ?? 0) & 1 << bit) action(item.id, a)
      const seam = testing ? injected.get(i)?.read(now) ?? null : null,
        body = seam ?? (owner === 'host' && captureActive && captureSeat === i ? camera : owner && owner !== 'host' ? input?.body ?? null : null),
        feed = seam ? 'test' : owner === 'host' && captureActive && captureSeat === i ? 'camera' : owner && owner !== 'host' ? `phone:${owner}` : ''
      if (feed !== a.feed) { a.feed = feed; a.retarget.reset() }
      a.body = a.retarget.step(body, now)
      a.rig.detail(stage.camera.position)
      const physics = current?.actors.find(s => s.actorId === a.id)
      if (physics) {
        for (const foot of physics.loadedFeet) if (!a.loadedFeet.has(foot)) sound.bus.emit({ kind: 'footstep', source: `${a.id}.${foot}`,
          at: a.rig.root.position.toArray() as [number, number, number], strength: .2, who: owner || undefined })
        a.loadedFeet = new Set(physics.loadedFeet)
      }
      for (const shadow of a.shadows) {
        const foot = a.rig.point(shadow.joint)
        shadow.mesh.position.set(foot.x, .002, foot.z - .035)
        shadow.mesh.material.uniforms.strength.value = Math.max(0, .6 - Math.max(0, foot.y - .08) * 2)
        shadow.mesh.visible = a.rig.root.visible
      }
    }
    sound.tick(t)
    if (!busy && pendingSeconds > 0) {
      // Simulation default: 0.25 s maximum queued elapsed time; expose any discard without changing the fixed-tick rate.
      if (pendingSeconds > .25) { droppedSeconds += pendingSeconds - .25; pendingSeconds = .25 }
      busy = true; advanceRequest = ++sequence
      worker.postMessage({ kind: 'advance', request: advanceRequest, seconds: pendingSeconds,
        inputs: Object.fromEntries(actors.slice(0, count).map(a => [a.id, { body: a.body, preset: a.preset ? presetPose(KEEL, a.preset, (now - a.presetAt) / 1200) : null }])) })
      pendingSeconds = 0
    }
    if (now - uiAt > 150 && current) {
      uiAt = now
      for (const [i, a] of current.actors.entries()) $('physics-actor' + (i + 1)).textContent = `Keel ${i + 1} · ${a.mode} / ${a.source} · up-Y ${a.upY.toFixed(3)} · ${a.support} support · effort ${(a.effortRatio * 100).toFixed(0)}%`
      const s = current.actors[selected]
      $('physics-status').textContent = s ? `up-Y ${s.upY.toFixed(3)} · ${s.support} support · effort ${(s.effortRatio * 100).toFixed(0)}%` : 'Preparing actor'
      $('physics-fall').hidden = !current.actors.some(a => a.fallen)
      $('seat-owner').textContent = actors[selected].owner ? `${actors[selected].name} · ${sim?.nameOf(actors[selected].owner) ?? actors[selected].owner}` : 'Pair a phone to control your actor.'
    }
    if (now - budgetAt > 2000 && budgetWorkTimesMs.length > 120) {
      budgetAt = now
      const workP95 = percentile(budgetWorkTimesMs, .95), seconds = budgetWorker.reduce((sum, sample) => sum + sample.seconds, 0),
        utilisation = seconds ? budgetWorker.reduce((sum, sample) => sum + sample.workMs, 0) / (seconds * 1000) : 0
      $('physics-budget').textContent = `Worker physics · frame work p95 ${workP95.toFixed(1)} ms${degraded ? ' · two-actor preview disabled to protect frame work' : ''}`
      if (!degraded && now - sampleOrigin > 10000 && count === 2 && (workP95 > 16.7 || utilisation > .8)) {
        degraded = true; $<HTMLInputElement>('physics-two').disabled = true; void actorCount(1)
        sim?.note('Frame budget exceeded. The arena restarted with one actor; physics tick rate and gates stay unchanged.')
      }
    }
    stage.view.invalidate()
  }
  stage.afterRender = () => {
    const workMs = performance.now() - workBegin + pendingEventWorkMs
    pendingEventWorkMs = 0
    if (!ready) return
    budgetWorkTimesMs.push(workMs); if (budgetWorkTimesMs.length > 240) budgetWorkTimesMs.shift()
    if (measure) retain(workTimesMs, [workMs])
  }
  const resetMetrics = () => { workTimesMs.length = tickTimesMs.length = workerTimesMs.length = frameIntervalsMs.length = 0; workerWorkMs = workerAdvancedSeconds = 0;
    droppedStart = droppedSeconds + (current?.droppedSeconds ?? 0); pendingEventWorkMs = 0; sampleOrigin = performance.now(); measure = true }
  if (testing) Object.assign(window, { __humanoidControl: {
    actors, stage, fixtureProfile: KEEL, ready: () => ready,
    snapshot: () => ({ ready, host: 'worker', actorCount: count, tick: current?.tick ?? 0, droppedSeconds: droppedSeconds + (current?.droppedSeconds ?? 0), degraded,
      disturbances: current?.actors.reduce((sum, actor) => sum + actor.disturbances, 0) ?? 0,
      actors: current?.actors.map((s, i) => ({ ...s, owner: actors[i].owner, feed: actors[i].feed, tracked: actors[i].body?.tracked ?? false, q: actors[i].body?.q ?? {} })) ?? [] }),
    metrics: () => ({ workTimesMs: [...workTimesMs], tickTimesMs: [...tickTimesMs], workerTimesMs: [...workerTimesMs], frameIntervalsMs: [...frameIntervalsMs],
      workerUtilisation: workerAdvancedSeconds ? workerWorkMs / (workerAdvancedSeconds * 1000) : 0, droppedSeconds: Math.max(0, droppedSeconds + (current?.droppedSeconds ?? 0) - droppedStart), gfx: stage.view.gfx() }),
    reset, actorCount, push, stance, startMeasure: resetMetrics, resetMetrics,
    endMeasure: () => { measure = false; return { workTimesMs: [...workTimesMs], tickTimesMs: [...tickTimesMs], workerUtilisation: workerAdvancedSeconds ? workerWorkMs / (workerAdvancedSeconds * 1000) : 0,
      droppedSeconds: Math.max(0, droppedSeconds + (current?.droppedSeconds ?? 0) - droppedStart), gfx: stage.view.gfx() } },
    inject: (index: number, state: BodyState) => { if (!injected.has(index)) injected.set(index, new BodyInput()); injected.get(index)!.receive(encodeBody(state)) },
    clear: (index: number) => injected.delete(index),
    camera: (position: [number, number, number], target: [number, number, number]) => { stage.controls.target.set(...target); stage.camera.position.set(...position); stage.controls.update() },
  } })
  addEventListener('pagehide', () => { worker.terminate(); for (const p of pending.values()) p.reject(new Error('Page closed')); pending.clear() }, { once: true })
  await actorCount(1)
  resetMetrics()
})
