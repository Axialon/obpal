import * as THREE from 'three'
import { batch, floorMaterial, glass, maker, metal, plastic, rubber } from '../kit'
import { SubmarineLogic, SUBMARINE_WRECKS } from './submarine'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { mats, plate, wear, type DeviceView } from './view'

function submarine(n: number) {
  const root = new THREE.Group(), hull = new THREE.Group(), fittings = new THREE.Group(), prop = new THREE.Group()
  root.name = `submarine-${n + 1}`; hull.name = 'pressure-hull'; fittings.name = 'ballast-and-fins'; prop.name = 'propeller'
  root.add(hull, fittings, prop)
  const paint = plastic(n ? '#ddac54' : '#dcded5'), glow = mats.glow()
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), paint)
  shell.scale.set(0.5, 0.48, 1.2); shell.castShadow = true; hull.add(shell)
  block(hull, [0.46, 0.46, 0.52], [0, 0.51, 0.04], paint)
  rod(fittings, [0, 0.7, 0.08], [0, 1.15, 0.08], 0.045)
  rod(fittings, [0, 1.15, 0.08], [0, 1.15, -0.12], 0.045)
  for (const x of [-0.47, 0.47]) {
    const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 1.1, 4, 12), plastic('#5b747e'))
    tank.rotation.x = Math.PI / 2; tank.position.set(x, -0.22, 0.1); fittings.add(tank)
    for (const z of [-0.5, 0.15, 0.62]) {
      const rim = disc(fittings, 0.12, 0.04, [x, 0.08, z], metal); rim.rotation.z = Math.PI / 2
      const port = disc(fittings, 0.087, 0.05, [x * 1.045, 0.08, z], glass); port.rotation.z = Math.PI / 2
    }
  }
  block(fittings, [1.4, 0.055, 0.3], [0, -0.04, 0.86], paint)
  block(fittings, [0.045, 0.64, 0.32], [0, 0.16, 0.94], paint)
  prop.position.set(0, 0, 1.28)
  for (const a of [0, Math.PI / 3, Math.PI * 2 / 3]) {
    const blade = block(prop, [0.62, 0.065, 0.05], [0, 0, 0], metal); blade.rotation.z = a
  }
  const cage = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.025, 8, 32), rubber)
  cage.position.z = 1.28; fittings.add(cage)
  const lamp = disc(fittings, 0.105, 0.06, [0, -0.1, -1.16], glow); lamp.rotation.x = Math.PI / 2
  const number = plate(n + 1, 0.25); number.position.set(0, 0.55, -0.235); hull.add(number)
  maker(hull, 0, 0.755, 0.02, 0.16)
  for (const part of [hull, fittings, prop]) batch(part)
  return { root, prop, glow }
}
function seafloor(scene: THREE.Scene, logic: SubmarineLogic) {
  scene.fog = new THREE.FogExp2('#266271', 0.027)
  const floor = new THREE.Group(); floor.name = 'seabed'; scene.add(floor)
  block(floor, [34, 0.22, 32], [0, -0.26, 0], floorMaterial('#687f79'))
  for (let n = 0; n < 28; n++) {
    const a = n * 2.39996, radius = 5 + n % 7 * 1.6
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.4 + n % 3 * 0.2, 0), plastic(n % 2 ? '#526d68' : '#819088'))
    rock.position.set(Math.sin(a) * radius, 0.08, Math.cos(a) * radius); rock.scale.y = 0.55; floor.add(rock)
  }
  batch(floor)
  const causticMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { time: { value: 0 } },
    vertexShader: 'varying vec2 at; void main(){ at=uv*28.0; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'uniform float time; varying vec2 at; void main(){ float a=sin(at.x*2.7+sin(at.y*1.8+time*.4)); float b=sin(at.y*3.0+sin(at.x*1.6-time*.3)); float c=pow(max(0.0,1.0-abs(a+b)*2.6),5.0); gl_FragColor=vec4(.38,.75,.71,c*.24); }',
  })
  const caustics = new THREE.Mesh(new THREE.PlaneGeometry(33, 31), causticMaterial)
  caustics.name = 'moving-caustics'; caustics.rotation.x = -Math.PI / 2; caustics.position.y = -0.135; scene.add(caustics)
  const shafts = new THREE.Group(); shafts.name = 'light-shafts'; scene.add(shafts)
  const shaftMaterial = new THREE.MeshBasicMaterial({ color: '#94d7d3', transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })
  for (let n = 0; n < 5; n++) {
    const ray = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 1.8, 12, 12, 1, true), shaftMaterial)
    ray.position.set(-10 + n * 5, 5.2, -5 + n % 2 * 8); ray.rotation.z = -0.16; shafts.add(ray)
  }
  batch(shafts, [], true)
  const wrecks = SUBMARINE_WRECKS.map((w, n) => {
    const root = new THREE.Group(); root.name = `wreck-${n + 1}`; root.position.set(w.x, 0, w.z); root.rotation.y = n * 0.85; scene.add(root)
    const rust = plastic('#76634e')
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), rust)
    shell.scale.set(0.85, 0.37, 1.9); shell.position.y = 0.25; root.add(shell)
    block(root, [1.05, 0.4, 2.4], [0, 0.48, 0], plastic('#3e575a'))
    block(root, [0.8, 0.6, 0.8], [0, 0.89, 0.35], rust)
    rod(root, [0, 0.6, -0.5], [0.4, 2, -0.1], 0.045, rust)
    for (const x of [-0.6, 0.6]) rod(root, [x, 0.6, -1.1], [x, 0.6, 1.1], 0.025, rust)
    const glow = mats.glow('#4d6967'); disc(root, 0.12, 0.06, [0, 1.23, 0.35], glow)
    batch(root)
    return glow
  })
  const models = logic.units.map((_, n) => { const m = submarine(n); scene.add(m.root); return m })
  const pings = models.map((_, n) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14), new THREE.MeshBasicMaterial({ color: n ? '#e9c97b' : '#91eadb', wireframe: true, transparent: true, opacity: 0.23, depthWrite: false }))
    mesh.name = `sonar-pulse-${n + 1}`; scene.add(mesh); return mesh
  })
  return {
    step(t: number, colors: readonly (string | null)[] = []) {
      causticMaterial.uniforms.time.value = t
      models.forEach((m, n) => {
        const u = logic.units[n]
        m.root.position.set(u.x, u.y, u.z); m.root.rotation.set(u.pitch, u.h, 0, 'YXZ'); m.prop.rotation.z = u.prop
        wear(m.glow, colors[n] ?? null)
        pings[n].visible = u.ping > 0; pings[n].position.set(u.pingX, u.pingY, u.pingZ); pings[n].scale.setScalar(Math.max(0.01, u.ping))
        pings[n].material.opacity = (1 - u.ping / 6) * 0.3
      })
      wrecks.forEach((m, n) => { m.emissive.set(logic.units.some((u) => !!(u.found & (1 << n))) ? '#c6ff34' : '#4d6967') })
    },
  }
}
export function createView(stage: Stage, logic: SubmarineLogic): DeviceView {
  stage.ground.visible = false
  const w = seafloor(stage.scene, logic), at = (n: number): [number, number, number] => [logic.units[n].x, logic.units[n].y + 0.15, logic.units[n].z]
  return {
    framing: playFrame(at(0), 1.4, [1, 0.55, 1.4]), overview: playFrame([0, 2, 0], 15), inspect: () => playFrame(at(0), 1),
    follow: (n) => new THREE.Vector3(...at(n)), update: (colors, t) => { w.step(t, colors); stage.view.invalidate() },
  }
}
export function preview() {
  const logic = new SubmarineLogic()
  return showcase((scene) => {
    const w = seafloor(scene, logic)
    return { step(t) { logic.units[0].y = 4 + Math.sin(t * 0.7) * 0.07; logic.units[0].prop = t * 5; w.step(t) } }
  }, [-1.8, 4.15, 4], 1.5)
}
