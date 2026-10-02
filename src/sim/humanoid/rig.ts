/** Authored skins on the live named joint tree, with a procedural download fallback. */
import * as THREE from 'three'
import { box, plastic, metal, batch } from '../kit'
import { forward, v } from './ik'
import { neutral, type Angles, type RigProfile } from './profile'
import type { ContactActor } from './contacts'
import { previewScene, type Preview } from '../devices/view'
import { HUMANOID } from './profile'
import { presetPose } from './controls'
import { loadPrototype, finishPrototype, retirePrototype } from '../kit/prototype'
import { holdRig } from '../kit/reveal'
import { modelName, modelPivots, retainSkin } from './models'
import { FaceLight } from './face'
import { softPhone } from './soft-materials'
import type { RigHold } from '../kit/reveal'
import type { Grip } from './fingers'
import { fingerAngles } from './tendons'
import { localRigFrames } from './physics/binding'
import type { WorldFrame } from './physics/model'

export class Rig {
  readonly root = new THREE.Group()
  readonly pivots = new Map<string, THREE.Group>()
  private physicalFrames: Record<string, WorldFrame> | null = null
  private fk = forward(this.profile, neutral(this.profile))
  private skins: THREE.Group[][] = []
  private level = 0
  private loaded = false
  private disposed = false
  private hold?: RigHold
  private release?: () => void
  private fallbackMaterials: THREE.Material[] = []
  readonly faceLight = this.profile.face ? new FaceLight(this.profile) : null
  private grips: Grip = { left: 0, right: 0 }
  private fingers: {
    side: keyof Grip
    first: THREE.Object3D
    tip: THREE.Object3D
    distal: THREE.Object3D
    thumb?: THREE.Object3D
    thumbTip?: THREE.Object3D
  }[] = []
  constructor(
    readonly profile: RigProfile,
    readonly variant = 0,
  ) {
    const soft = !!profile.face
    const shell = soft ? softPhone[profile.model!.split('-')[0]+'Cover'].clone() : plastic(variant ? '#3b4549' : '#252b32'),
      trim = soft ? softPhone.softCore.clone() : plastic('#11171d')
    const lime = new THREE.MeshStandardMaterial({
      color: '#c6ff34',
      emissive: '#c6ff34',
      emissiveIntensity: 0.3,
      roughness: soft ? .65 : .35,
    })
    const glass = soft ? softPhone.softGlass.clone() : plastic('#455c63')
    const jointMetal = soft ? softPhone.softGraphite.clone() : metal
    this.fallbackMaterials = [shell, trim, lime, glass]
    if (soft) this.fallbackMaterials.push(jointMetal)
    for (const j of profile.joints) {
      const pivot = new THREE.Group()
      pivot.name = j.id
      pivot.position.set(...j.offset)
      this.pivots.set(j.id, pivot)
      ;(j.parent ? this.pivots.get(j.parent)! : this.root).add(pivot)
    }
    const materials = { shell, trim, glass, accent: lime, metal: jointMetal }
    for (const skin of profile.skins) {
      const mesh = skin.axle
        ? new THREE.Mesh(
            new THREE.CylinderGeometry(skin.size[0], skin.size[0], skin.size[1], 12),
            materials[skin.finish],
          )
        : box(...skin.size, materials[skin.finish])
      if (skin.axle) mesh.rotation.z = Math.PI / 2
      mesh.position.set(...skin.offset)
      this.pivots.get(skin.joint)!.add(mesh)
    }
    batch(this.root, [...this.pivots.values()])
  }
  /** Reveal once, then exchange detail levels without changing any joint or replaying the entrance. */
  load() {
    if (this.loaded) return
    this.loaded = true
    const name = modelName(this.profile)
    this.release = retainSkin(this.profile)
    const hold = this.hold = holdRig(name, [this.root])
    void loadPrototype(name).then((scene) => {
      if (this.disposed) return
      if (!scene) {
        hold.fallback()
        return
      }
      hold.install(() => this.install(scene, 0))
      if (this.root.userData.prototype !== 'blender') return
      void loadPrototype(`${name}-lod`).then((low) => {
        if (low && !this.disposed) {
          try {
            this.install(low, 1)
          } catch {
            /* Keep the valid full-detail skin. */
          }
        }
      })
    })
  }
  private install(scene: THREE.Group, level: number) {
    const nodes = modelPivots(scene, this.profile, this.faceLight?.material)
    const jointNodes = new Set(nodes.values())
    const groups = [...nodes].map(([id, node]) => {
      const group = new THREE.Group()
      group.userData.joint = id
      for (const child of [...node.children]) if (!jointNodes.has(child)) group.add(child)
      return group
    })
    if (level === 0) {
      for (const pivot of this.pivots.values()) {
        for (const child of [...pivot.children]) if ((child as THREE.Mesh).isMesh) retirePrototype(child)
      }
    }
    this.profile.joints.forEach((joint, i) => {
      groups[i].visible = level === this.level
      this.pivots.get(joint.id)!.add(groups[i])
    })
    this.skins[level] = groups
    for (const side of ['left', 'right'] as const) {
      const group = groups[this.profile.joints.findIndex((j) => j.id === `${side}.arm.wrist.yaw`)]
      const first = group?.getObjectByName(`${side}_arm_fingers`),
        tip = group?.getObjectByName(`${side}_arm_tips`),
        distal = group?.getObjectByName(`${side}_arm_distal`)
      const thumb = group?.getObjectByName(`${side}_arm_thumb`),
        thumbTip = group?.getObjectByName(`${side}_arm_thumb_tip`)
      if (first && tip && distal) this.fingers.push({ side, first, tip, distal, thumb, thumbTip })
    }
    this.root.userData.lods = this.skins.filter(Boolean).length
    this.grip(this.grips)
  }
  /** Cancel late installs and release only this rig's resources; shared soft skins are reference counted. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.hold?.cancel()
    retirePrototype(this.root)
    this.release?.()
    this.faceLight?.dispose()
    for (const material of this.fallbackMaterials) material.dispose()
  }
  face(seconds: number, tracking: boolean, reduced: boolean) { this.faceLight?.step(seconds, tracking, reduced) }
  /** A collective tendon curls the three phalanges and linked opposable thumb. */
  grip(value: Grip) {
    this.grips = value
    for (const { side, first, tip, distal, thumb, thumbTip } of this.fingers) {
      const curl = THREE.MathUtils.clamp(value[side], 0, 1)
      const angles = fingerAngles(this.profile, curl)
      first.rotation.x = angles[0]
      tip.rotation.x = angles[1]
      distal.rotation.x = angles[2]
      if (thumb) thumb.rotation.x = curl * 0.55
      if (thumbTip) thumbTip.rotation.x = curl * 0.7
    }
  }
  /** Hysteresis keeps distant actors stable when an orbit straddles the LOD boundary. */
  detail(camera: THREE.Vector3) {
    const distance = camera.distanceTo(this.root.position)
    const next = this.skins[1] && distance > (this.level ? 5.5 : 6.5) ? 1 : 0
    if (next === this.level) return
    this.level = next
    this.skins.forEach((groups, level) =>
      groups.forEach((group) => {
        group.visible = level === next
      }),
    )
    this.root.userData.lod = next
  }
  /** Physics owns every world transform. This consumes interpolation only; no engine reference or write-back exists. */
  poseWorld(frames: Readonly<Record<string, WorldFrame>>) {
    const local = localRigFrames(this.profile, frames)
    for (const j of this.profile.joints) {
      const f = local.joints[j.id], pivot = this.pivots.get(j.id)!
      pivot.position.set(f.position.x, f.position.y, f.position.z)
      pivot.quaternion.set(f.rotation.x, f.rotation.y, f.rotation.z, f.rotation.w)
    }
    this.root.position.set(local.root.position.x, local.root.position.y, local.root.position.z)
    this.root.quaternion.set(local.root.rotation.x, local.root.rotation.y, local.root.rotation.z, local.root.rotation.w)
    this.physicalFrames = local.world
  }
  pose(q: Angles, position = new THREE.Vector3(), yaw = 0, offset = new THREE.Vector3()) {
    if (this.physicalFrames) {
      for (const j of this.profile.joints) this.pivots.get(j.id)!.position.set(...j.offset)
      this.physicalFrames = null
      this.root.rotation.set(0, 0, 0)
    }
    for (const j of this.profile.joints) this.pivots.get(j.id)!.quaternion.setFromAxisAngle(v(j.axis), q[j.id] || 0)
    this.root.position
      .copy(offset)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      .add(position)
    this.root.rotation.y = yaw
    this.fk = forward(this.profile, q)
  }
  point(id: string) {
    if (this.physicalFrames) {
      const f = this.physicalFrames[id]
      if (!f) throw new RangeError('Unknown physical rig frame')
      return new THREE.Vector3(f.position.x, f.position.y, f.position.z)
    }
    return this.fk
      .get(id)!
      .p.clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.root.rotation.y)
      .add(this.root.position)
  }
  contact(id: string, blocked: boolean): ContactActor {
    const arms = this.profile.chains.filter((c) => c.group === 'arms')
    const chest = this.point(this.profile.frame?.head[0] ?? this.profile.root).add(new THREE.Vector3(0, -0.12, 0)),
      fists = arms.map((c) => this.point(c.end))
    return {
      id,
      blocked: blocked || fists.some((p) => p.y > chest.y - 0.12),
      chest,
      pelvis: this.point(this.profile.root),
      fists,
      elbows: arms.map((c) => this.point(c.joints[3])),
      shoulders: arms.map((c) => this.point(c.joints[0])),
    }
  }
}
export function arena() {
  const group = new THREE.Group(),
    floor = box(8, 0.12, 8, new THREE.MeshStandardMaterial({ color: '#1b2328', roughness: 0.9, metalness: 0.1 }))
  floor.position.y = -0.08
  group.add(floor)
  const lines: number[] = []
  for (let i = -3; i <= 3; i++) {
    lines.push(i, -0.014, -3.6, i, -0.014, 3.6, -3.6, -0.014, i, 3.6, -0.014, i)
  }
  const grid = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)),
    new THREE.LineBasicMaterial({ color: '#394449' }),
  )
  group.add(grid)
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(7.7, 0.012, 7.7)),
    new THREE.LineBasicMaterial({ color: '#72863f' }),
  )
  group.add(edge)
  const line = box(0.012, 0.015, 1.2, plastic('#c6ff34'))
  line.position.set(-2, 0, 0)
  group.add(line)
  const other = line.clone()
  other.position.x = 2
  group.add(other)
  batch(group)
  const hold = holdRig('humanoid-arena', [group])
  void loadPrototype('humanoid-arena').then((scene) => {
    if (!scene) {
      hold.fallback()
      return
    }
    hold.install(() => {
      finishPrototype(scene)
      for (const child of [...group.children]) retirePrototype(child)
      group.add(scene)
    })
  })
  return group
}
export function preview(): Preview {
  const scene = previewScene(),
    rig = new Rig(HUMANOID)
  scene.add(rig.root)
  const camera = new THREE.PerspectiveCamera(35, 1.6, 0.05, 40)
  camera.position.set(2, 1.7, -3.3)
  camera.lookAt(0, 0.9, 0)
  return { scene, camera, step: (t) => rig.pose(presetPose(HUMANOID, 'wave', (t % 2.2) / 2.2)) }
}
