/** Two independently claimed robots share a practice arena. Capture changes articulation;
 * classical controls move the root. The scene holds while personal ranges are measured. */
import '../../styles/base.css'
import '../../styles/sim.css'
import '../../styles/humanoid.css'
import * as THREE from 'three'
import { BodyInput, type BodyFrame, type Layout } from '@obpal/host'
import { Controller, encodeBody, type BodyState } from '@obpal/core'
import { family } from '../../family'
import { applyTheme, initialTheme, themeById } from '../../ui/themes'
import { mountMarks } from '../../ui/icons'
import { mountTopBar } from '../../landing/topbar'
import { mountQuick, quickAction } from '../../ui/quick'
import { mountBodyCapture, toggleBodyCapture } from '../../ui/body-capture'
import { createStage } from '../devices/stage'
import { Seats } from '../devices/seats'
import { startSimScene, type SimScene } from '../scene'
import { mountSimPanels, numberSections } from '../ui/panels'
import { mountSound } from '../audio/session'
import { HUMANOID, KEEL, MORROW, robotRoster, clamp } from './profile'
import { softPreview } from './preview'
import { forward } from './ik'
import { Rig, arena } from './rig'
import { Retargeter, FootBalance, type Retargeted } from './retarget'
import { ActorControl, classical, PRESETS } from './controls'
import { Contacts, PracticeMode } from './contacts'
import { CALIBRATION_KEY, parseCalibration } from './calibration'
import { WalkthroughView } from './walkthrough'
import { FingerInput } from './fingers'
import { Tendons } from './tendons'
import { iconAction } from '../../ui/kit/action'
import { lightArena, quietHorizon, soleShadow } from './lighting'
import { DriverPanel } from './driver-panel'
import { upperJoints } from './driver-profile'
import { startScene } from '../kit/recovery'

startScene(() => {
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const previewSoft = softPreview(location.search)
const robots = robotRoster(previewSoft)
if (previewSoft) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]') ?? document.createElement('meta')
  meta.name = 'robots'
  meta.content = 'noindex, follow'
  document.head.append(meta)
}
applyTheme(initialTheme())
mountMarks()
mountTopBar()
mountQuick()
family.watchTheme()
const panels = mountSimPanels('humanoid', 'Controls')
const stage = createStage($('stage') as HTMLCanvasElement, initialTheme(), { maxDpr: 1.5, portraitFraming: true })
addEventListener('bb-theme', (e) => {
  stage.setTheme(themeById((e as CustomEvent<{ theme: string }>).detail.theme))
  quietHorizon(stage)
})
stage.renderer.shadowMap.enabled = false
lightArena(stage)
stage.scene.add(arena())
const framing = {
  target: [0, 0.9, 0] as [number, number, number],
  wide: [3.8, 2.7, -5.7] as [number, number, number],
  tall: [3.5, 3, -6.5] as [number, number, number],
  radius: 2,
  min: 3,
  max: 16,
}
stage.frame(framing)
quietHorizon(stage)
addEventListener('obpal:panels', () => {
  stage.resize()
  stage.frame(framing)
  quietHorizon(stage)
})
const actors = ['Keel', 'Morrow'].map((name, i) => {
  const profile = i ? MORROW : KEEL,
    rig = new Rig(profile, i),
    control = new ActorControl(profile),
    retarget = new Retargeter(profile)
  control.position.x = i ? 0.65 : -0.65
  control.yaw = i ? Math.PI / 2 : -Math.PI / 2
  stage.scene.add(rig.root)
  rig.load()
  const shadows = profile.chains
    .filter((chain) => chain.group === 'legs')
    .map((chain) => {
      const mesh = soleShadow()
      stage.scene.add(mesh)
      return { joint: chain.end, mesh }
    })
  return {
    id: `robot-${i + 1}`,
    name,
    rig,
    control,
    retarget,
    balance: new FootBalance(),
    owner: '',
    source: 'classical',
    calibrationKey: '',
    saved: '',
    last: null as Retargeted | null,
    offset: new THREE.Vector3(),
    generation: -1,
    fingers: new FingerInput(),
    tendons: new Tendons(profile),
    shadows,
  }
})
let selected = 0,
  sim: SimScene | null = null,
  seats: Seats | null = null,
  localSource = 'classical',
  localActive = false,
  stopped = false
const localCaptureOrigin = performance.now()
const localBody = mountBodyCapture({
    timeOrigin: localCaptureOrigin,
    beforeOpen: () => takeLocal('body'),
    closed: () => {
      if (localSource === 'body') {
        localActive = false
        sim?.release('host')
      }
    },
  }),
  contacts = new Contacts(),
  keys = new Set<string>()
// The existing articulated-machine profile already supplies servo synthesis and credited foot samples.
const sound = mountSound('dog', (strong, weak, ms, who) => sim?.remote.rumble(strong, weak, ms, who))
numberSections()
const storageKey = (owner: string) => {
  if (owner === 'host') return `${CALIBRATION_KEY}local`
  const p = sim?.remote.participants.find((p) => p.id === owner)
  return `${CALIBRATION_KEY}${p?.fp ?? p?.pair ?? owner}`
}
function load(actor: (typeof actors)[number], owner: string) {
  actor.calibrationKey = storageKey(owner)
  try {
    actor.retarget.data = parseCalibration(localStorage.getItem(actor.calibrationKey), actor.control.profile)
  } catch {
    actor.retarget.data = parseCalibration(null, actor.control.profile)
  }
  actor.saved = JSON.stringify(actor.retarget.data)
}
function save(actor: (typeof actors)[number], data = actor.retarget.data) {
  actor.retarget.data = data
  // Re-parse before serialisation: even the synthetic seam cannot persist camera arrays or unknown fields.
  const clean = JSON.stringify(parseCalibration(JSON.stringify(data), actor.control.profile))
  if (clean === actor.saved || !actor.calibrationKey) return
  try {
    localStorage.setItem(actor.calibrationKey, clean)
    actor.saved = clean
  } catch {
    /* Private browsing: calibration remains usable for this visit. */
  }
}
const walkthrough = new WalkthroughView(HUMANOID, actors[0].retarget.data, (data, reset) => {
  if (reset) actors[selected].retarget.reset()
  save(actors[selected], data)
})
// This retargeter consumes local capture directly; practice presets and phone input never reach it.
const driverRetarget = new Retargeter(HUMANOID)
const drivers: DriverPanel = new DriverPanel(
  panels,
  () => {
    const now = performance.now(),
      body = localBody.read(now),
      actor = actors[selected]
    driverRetarget.data = actor.retarget.data
    driverRetarget.setMirror(actor.retarget.mirror)
    const pose = driverRetarget.step(body, now)
    const elapsed = Math.round((now - localCaptureOrigin) * 1000) >>> 0
    const age = body ? ((elapsed - body.t) >>> 0) / 1000 : Infinity
    return {
      kind: 'body',
      token: `body:${selected}:${pose.generation}:${driverRetarget.mirror}`,
      positions: pose.q,
      at: now - age,
      preset: false,
      valid:
        !!body &&
        pose.tracked &&
        !pose.calibrating &&
        !walkthrough.dialog.open &&
        !!drivers.session.driver &&
        upperJoints(drivers.session.driver.profile).every((j) => pose.valid.has(j.id)),
    }
  },
  () => toggleBodyCapture(),
)
function choose(index: number) {
  if (walkthrough.dialog.open) walkthrough.dialog.close()
  selected = index
  document
    .querySelectorAll<HTMLButtonElement>('[data-seat]')
    .forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.seat) === selected)))
  $('mirror').toggleAttribute('checked', actors[selected].retarget.mirror)
  ;($('mirror') as HTMLInputElement).checked = actors[selected].retarget.mirror
  refreshRobotChoice()
}

const robotChoice = $('robot-choice') as HTMLSelectElement
for (const robot of robots) {
  const option = document.createElement('option')
  option.value = robot.id
  option.textContent = robot.name
  robotChoice.append(option)
}
function refreshRobotChoice() {
  const actor = actors[selected]
  const robot = robots.find((robot) => robot.forms.some((profile) => profile.id === actor.control.profile.id))!
  robotChoice.value = robot.id
  $('robot-forms').hidden = robot.forms.length === 1
  document.querySelectorAll<HTMLButtonElement>('[data-form]').forEach((button) => {
    button.setAttribute('aria-pressed', String(robot.forms[Number(button.dataset.form)]?.id === actor.control.profile.id))
  })
}
/** A seat keeps its claim and calibration; a new form starts from a bounded rest pose. */
function changeRobot(id: string, form = 0) {
  const robot = robots.find((robot) => robot.id === id)
  const profile = robot?.forms[form]
  if (!robot || !profile) return
  const actor = actors[selected]
  const holder = sim?.claims.holder(actor.id)
  if (holder && holder !== 'host') { sim?.note(`${actor.name} is held by ${sim.nameOf(holder)}`); refreshRobotChoice(); return }
  if (profile.id === actor.control.profile.id) return
  if (walkthrough.dialog.open) walkthrough.dialog.close()
  keys.clear()
  const control = new ActorControl(profile)
  control.position.copy(actor.control.position)
  control.yaw = actor.control.yaw
  if (actor.control.stopped) control.stop()
  const retarget = new Retargeter(profile)
  retarget.data = actor.retarget.data
  retarget.setMirror(actor.retarget.mirror)
  actor.rig.dispose()
  actor.name = robot.name
  actor.control = control
  actor.retarget = retarget
  actor.rig = new Rig(profile, selected)
  actor.tendons = new Tendons(profile)
  actor.fingers = new FingerInput()
  actor.balance.reset()
  actor.last = null
  actor.generation = -1
  actor.offset.set(0, 0, 0)
  contacts.resetMotion()
  actor.rig.pose(control.q, control.position, control.yaw)
  stage.scene.add(actor.rig.root)
  actor.rig.load()
  const seat = document.querySelector<HTMLButtonElement>(`[data-seat="${selected}"]`)!
  seat.textContent = robot.name
  if (profile.model) seat.setAttribute('aria-label', `${robot.name}, seat ${selected + 1}, Form ${form ? 'II' : 'I'}`)
  else seat.removeAttribute('aria-label')
  sim?.setNodes(actors.map((a) => ({ id: a.id, name: a.name, kind: 'slot', group: 'Robots' })))
  refreshRobotChoice()
}
robotChoice.onchange = () => changeRobot(robotChoice.value)
document.querySelectorAll<HTMLButtonElement>('[data-form]').forEach((button) => {
  button.onclick = () => changeRobot(robotChoice.value, Number(button.dataset.form))
})
refreshRobotChoice()
document
  .querySelectorAll<HTMLButtonElement>('[data-seat]')
  .forEach((b) => (b.onclick = () => choose(Number(b.dataset.seat))))
function takeLocal(source = localSource) {
  const actor = actors[selected],
    holder = sim?.claims.holder(actor.id)
  if (holder && holder !== 'host') {
    sim?.note(`${actor.name} is held by ${sim.nameOf(holder)}`)
    return false
  }
  if (sim && !sim.take(actor.id, 'host')) return false
  if (actor.owner !== 'host') {
    actor.owner = 'host'
    actor.retarget.reset()
    actor.balance.reset()
    actor.control.resetSource()
    load(actor, 'host')
  }
  if (!stopped) actor.control.resume()
  localActive = true
  localSource = source
  return true
}
$('local-body').onclick = () => toggleBodyCapture()
$('range-calibrate').onclick = () => {
  const actor = actors[selected]
  if (!actor.owner && !takeLocal('body')) return
  actor.control.resetSource()
  walkthrough.open(actor.retarget.data, actor.control.profile)
}
$('mirror').onchange = () => {
  actors[selected].retarget.setMirror(($('mirror') as HTMLInputElement).checked)
  actors[selected].balance.reset()
}
for (const name of PRESETS) {
  const b = document.createElement('button')
  b.className = 'kit-action'
  b.type = 'button'
  b.textContent = name[0].toUpperCase() + name.slice(1)
  b.dataset.move = name
  b.onclick = () => {
    if (takeLocal()) actors[selected].control.play(name)
  }
  $('moves').append(b)
}
const stop = () => {
  void drivers.session.stop('Stop')
  stopped = true
  keys.clear()
  for (const a of actors) {
    a.control.stop()
    a.tendons.freeze()
    a.balance.reset()
  }
  sound.stop()
  $('input-quality').textContent = 'Stopped'
  $('estop').setAttribute('aria-pressed', 'true')
}
$('estop').onclick = stop
$('resume').onclick = () => {
  stopped = false
  for (const a of actors) a.control.resume()
  $('estop').setAttribute('aria-pressed', 'false')
}
iconAction($('resume') as HTMLButtonElement, 'play', 'Resume')
$('reframe').onclick = () => {
  stage.frame(framing)
  quietHorizon(stage)
}
$('reset-score').onclick = () => contacts.reset()
$('scoring').onchange = () =>
  (contacts.mode = ($('scoring') as HTMLInputElement).checked ? PracticeMode.Practice : PracticeMode.Free)
quickAction({ id: 'stop', group: 'page', label: 'Stop', icon: 'stop', run: stop })
quickAction({
  id: 'reset',
  group: 'page',
  label: 'Recentre',
  icon: 'reset',
  run: () => {
    stage.frame(framing)
    quietHorizon(stage)
  },
})
document.querySelectorAll<HTMLButtonElement>('[data-drive]').forEach((b) => {
  b.onpointerdown = (e) => {
    if (!takeLocal()) return
    e.preventDefault()
    b.setPointerCapture(e.pointerId)
    keys.add(b.dataset.drive!)
  }
  b.onpointerup = b.onpointercancel = b.onlostpointercapture = () => keys.delete(b.dataset.drive!)
})
addEventListener('keydown', (e) => {
  if (walkthrough.dialog.open || (e.target as HTMLElement)?.closest('input,select,textarea')) return
  if (e.code === 'Space') {
    e.preventDefault()
    stop()
    return
  }
  const key = e.key.toLowerCase()
  if ('wasdqe'.includes(key) && key.length === 1) {
    e.preventDefault()
    if (takeLocal()) keys.add(key)
  }
  const preset = PRESETS[Number(key) - 1]
  if (preset && !e.repeat && takeLocal()) actors[selected].control.play(preset)
})
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))
addEventListener('blur', () => {
  keys.clear()
  for (const a of actors) a.control.resetSource()
})
addEventListener('pagehide', () => stage.renderer.setAnimationLoop(null))
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    keys.clear()
    for (const a of actors) {
      a.control.resetSource()
      a.balance.reset()
    }
  }
})
const layout: Layout = {
  v: 1,
  controllers: [Controller.gamepad, Controller.trackpad],
  utilities: ['pad', 'motion.tilt', 'touch.trackpad', 'camera.body', 'camera.hand'],
  tray: PRESETS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), type: 'button' as const })),
}
void startSimScene({
  appName: 'ob.Pal humanoids',
  layout,
  nodes: actors.map((a) => ({ id: a.id, name: a.name, kind: 'slot', group: 'Robots' })),
  approval: false,
  howTo: () => 'Sticks or tilt to move · Body camera to follow you',
  joined: (p) => {
    const free = actors.find((a) => !sim?.claims.holder(a.id))
    if (free) sim?.take(free.id, p.id)
  },
}).then((s) => {
  sim = s
  seats = new Seats(s.remote, layout)
  if (localActive) s.take(actors[selected].id, 'host')
})

const flashes = Array.from({ length: 4 }, () => {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.065, 0.09, 24),
    new THREE.MeshBasicMaterial({ color: '#c6ff34', transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  )
  mesh.visible = false
  stage.scene.add(mesh)
  return { mesh, until: 0 }
})
let lastSound = 0,
  uiAt = 0,
  flashIndex = 0,
  previousFrame = 0
const frameTimes: number[] = [],
  logicTimes: number[] = [],
  gpuTimes: number[] = [],
  renderTimes: number[] = []
const test =
  ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) &&
  ['humanoid', 'humanoid-live', 'load'].includes(new URLSearchParams(location.search).get('test') ?? '')
const injected = new Map<number, BodyInput>()
let inspecting = false
const faceMotion = matchMedia('(prefers-reduced-motion: reduce)')
stage.onFrame = (t, dt) => {
  for (const actor of actors)
    for (const shadow of actor.shadows) {
      const foot = actor.rig.point(shadow.joint)
      shadow.mesh.position.set(foot.x, 0.002, foot.z - 0.035)
      shadow.mesh.rotation.z = actor.rig.root.rotation.y
      shadow.mesh.material.uniforms.strength.value = Math.max(0, 0.6 - Math.max(0, foot.y - 0.08) * 2)
      shadow.mesh.visible = actor.rig.root.visible
    }
  if (test && inspecting) {
    stage.view.invalidate()
    return
  }
  const begin = performance.now(),
    now = t * 1000,
    inputs = seats?.read(now),
    local = localBody.read(now)
  for (let i = 0; i < actors.length; i++) {
    const a = actors[i],
      owner = sim?.claims.holder(a.id) ?? (localActive && selected === i ? 'host' : '')
    a.rig.detail(stage.camera.position)
    a.rig.face(t, !!a.last?.tracked && !a.control.stopped, faceMotion.matches)
    if (owner !== a.owner) {
      const lost = !!a.owner && !owner
      a.owner = owner
      a.retarget.reset()
      a.balance.reset()
      a.control.resetSource()
      a.generation = -1
      if (lost) a.control.stop()
      if (owner) {
        load(a, owner)
        if (!stopped) a.control.resume()
      }
    }
    const input = owner && owner !== 'host' ? inputs?.get(owner) : undefined
    const intent = classical(input)
    if (owner === 'host' && selected === i) {
      intent.x = Number(keys.has('d')) - Number(keys.has('a'))
      intent.z = Number(keys.has('s')) - Number(keys.has('w'))
      intent.yaw = Number(keys.has('e')) - Number(keys.has('q'))
      intent.manual = !!keys.size
    }
    let body: BodyFrame | null = test ? (injected.get(i)?.read(now) ?? null) : null
    body ??= owner === 'host' && localSource === 'body' ? local : (input?.body ?? null)
    const source = body ? 'body' : intent.manual || intent.preset ? 'classical' : a.source
    if (source !== a.source) {
      a.source = source
      a.retarget.reset()
      a.balance.reset()
      a.control.resetSource()
      a.tendons.freeze()
    }
    a.last = a.retarget.step(source === 'body' ? body : null, now)
    if (a.last.generation !== a.generation) {
      a.balance.reset()
      contacts.resetMotion()
      a.generation = a.last.generation
    }
    if (walkthrough.dialog.open) {
      if (selected === i) walkthrough.walk.sample(a.last.raw, a.last.valid)
      continue
    }
    save(a)
    const q = a.control.step(dt, intent, source === 'body' ? a.last.q : null)
    if (!a.control.stopped) {
      const balance = a.balance.step(a.control.profile, q, dt, a.control.moving)
      a.offset.copy(balance.root)
      const grip = a.fingers.step(body, input?.hand ?? null, a.retarget.mirror, owner)
      const closed = a.control.preset && a.control.preset !== 'wave'
      const pose = a.tendons.step(balance.q, closed ? { left: 1, right: 1 } : grip, dt)
      // Ground the actual elastic pose; the target's feet can be ahead during settling.
      const fk = forward(a.control.profile, pose),
        legs = a.control.profile.chains.filter((c) => c.group === 'legs')
      if (legs.length) {
        const lowest = Math.min(...legs.map((c) => fk.get(c.end)!.p.y - 0.08))
        a.offset.y = clamp(-lowest, -Math.max(0, fk.get(a.control.profile.root)!.p.y - 0.12), 0.4)
      }
      a.rig.pose(pose, a.control.position, a.control.yaw, a.offset)
      a.rig.grip(a.tendons.grip)
      for (const foot of balance.landed)
        sound.bus.emit({
          kind: 'footstep',
          source: `${a.id}.${foot}`,
          at: a.control.position.toArray(),
          strength: 0.2,
          who: owner || undefined,
        })
    }
    if (t - lastSound > 0.05 && !a.control.stopped)
      sound.bus.emit({
        kind: 'motor',
        source: a.id,
        at: a.control.position.toArray(),
        strength: a.control.moving || a.control.preset || a.last.tracked ? 0.15 : 0,
        texture: 'servo',
        rpm: a.control.moving ? 0.3 : 0.1,
        who: owner || undefined,
      })
  }
  if (t - lastSound > 0.05) {
    lastSound = t
    sound.tick(t)
  }
  if (!walkthrough.dialog.open && !actors.some((a) => a.control.stopped))
    for (const hit of contacts.step(
      actors.map((a) => a.rig.contact(a.id, a.control.preset === 'block' || a.control.preset === 'guard')),
      dt,
      t,
    )) {
      const attacker = actors.find((a) => a.id === hit.from),
        defender = actors.find((a) => a.id === hit.to)
      const spine = defender?.control.profile.frame?.spine[1]
      if (spine) defender?.tendons.contact(spine, hit.blocked ? 0.15 : 0.45)
      for (const chain of attacker?.control.profile.chains.filter((c) => c.group === 'arms') ?? [])
        attacker?.tendons.contact(chain.joints[3], -0.25)
      const f = flashes[flashIndex++ % flashes.length]
      f.mesh.position.copy(hit.at)
      f.mesh.lookAt(stage.camera.position)
      f.mesh.visible = !matchMedia('(prefers-reduced-motion: reduce)').matches
      f.until = t + 0.18
      sound.bus.emit({
        kind: 'contact',
        source: hit.to,
        at: hit.at.toArray(),
        strength: hit.blocked ? 0.25 : 0.55,
        materials: ['metal', 'rubber'],
        who: actors.find((a) => a.id === hit.from)?.owner || undefined,
      })
      $('input-quality').textContent = hit.blocked ? 'Blocked' : 'Contact'
    }
  for (const f of flashes) {
    if (t > f.until) f.mesh.visible = false
    else (f.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (f.until - t) / 0.18)
  }
  if (now - uiAt > 250) {
    uiAt = now
    const a = actors[selected]
    $('practice-score').textContent = actors.map((a) => contacts.scores[a.id] ?? 0).join(' · ')
    $('seat-owner').textContent = `${a.name} · ${a.owner ? (sim?.nameOf(a.owner) ?? 'This screen') : 'Free'}`
    if (!a.control.stopped)
      $('input-quality').textContent =
        a.source === 'body'
          ? a.last?.tracked
            ? a.last.calibrating
              ? 'Finding your proportions'
              : 'Body following'
            : 'Tracking paused'
          : 'Classical controls'
  }
  // Follow the pair's centre and back away only when needed, preserving the visitor's orbit angle.
  const centre = actors[0].control.position.clone().add(actors[1].control.position).multiplyScalar(0.5)
  centre.y = 0.9
  const spread = actors[0].control.position.distanceTo(actors[1].control.position) / 2
  const radius = Math.hypot(spread + 0.65, 0.95) * 1.15
  if (stage.controls.target.distanceTo(centre) > 0.3) stage.follow(centre)
  const need = radius / (Math.sin(THREE.MathUtils.degToRad(stage.camera.fov / 2)) * Math.min(1, stage.camera.aspect))
  const distance = stage.camera.position.distanceTo(stage.controls.target)
  if (distance < need) {
    stage.camera.position.sub(stage.controls.target).setLength(need).add(stage.controls.target)
    stage.controls.maxDistance = Math.max(stage.controls.maxDistance, need * 1.2)
  }
  if (test) {
    if (previousFrame) frameTimes.push(now - previousFrame)
    previousFrame = now
    logicTimes.push(performance.now() - begin)
    const gfx = stage.view.gfx()
    if (gfx.gpuMs !== null) gpuTimes.push(gfx.gpuMs)
    renderTimes.push(gfx.renderMs)
    for (const a of [frameTimes, logicTimes, gpuTimes, renderTimes]) if (a.length > 18000) a.shift()
  }
}
if (test)
  Object.assign(window, {
    __humanoid: {
      drivers,
      /** Local capture seam preserves the real capture-clock origin and BODY decoding. */
      injectLocal: (state: BodyState) => localBody.receive(encodeBody(state)),
      localCaptureOrigin,
      actors,
      changeRobot: (index: number, id: string, form = 0) => { choose(index); changeRobot(id, form) },
      camera: stage.camera,
      /** Loopback-only stills and joint sweeps use the actual live renderer and skins. */
      inspect: () => {
        inspecting = true
        stage.controls.enabled = false
        return stage
      },
      contacts,
      walkthrough,
      inject: (index: number, state: BodyState) => {
        let input = injected.get(index)
        if (!input) {
          input = new BodyInput()
          injected.set(index, input)
        }
        input.receive(encodeBody(state))
      },
      clear: (index: number) => injected.delete(index),
      snapshot: () => ({
        localSource,
        actors: actors.map((a) => ({
          id: a.id,
          owner: a.owner,
          source: a.source,
          q: a.control.q,
          position: a.control.position.toArray(),
          preset: a.control.preset,
          stopped: a.control.stopped,
          tracked: a.last?.tracked,
          calibrating: a.last?.calibrating,
        })),
        scores: contacts.scores,
        step: walkthrough.walk.step.id,
        done: [...walkthrough.walk.done],
        saved: actors[selected].retarget.data,
      }),
      metrics: () => ({ frameTimes, logicTimes, gpuTimes, renderTimes, gfx: stage.view.gfx() }),
      resetMetrics: () => {
        frameTimes.length = logicTimes.length = gpuTimes.length = renderTimes.length = 0
        previousFrame = 0
      },
      screenBounds: () =>
        actors.map((a) => {
          const box = new THREE.Box3().setFromObject(a.rig.root),
            points = []
          for (const x of [box.min.x, box.max.x])
            for (const y of [box.min.y, box.max.y])
              for (const z of [box.min.z, box.max.z]) points.push(stage.toScreen(new THREE.Vector3(x, y, z)))
          return points
        }),
    },
  })
})
