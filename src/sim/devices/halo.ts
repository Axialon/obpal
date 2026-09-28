/**
 * The live part on the model (PROTOCOL §3a): a thin ring in its holder's colour about each part the phone's trackpad
 * drives, breathing softly, that flares once as a switch lands on it; a part locked still wears a faint grey ring. The
 * view says where each part turns (DeviceView.partAt); the ring rides on it.
 */
import * as THREE from 'three'

/** Where a part moves about, in its own object: the axis it turns on (or slides along), and a ring's radius (m). */
export interface PartPivot { object: THREE.Object3D; axis: 'x' | 'y' | 'z'; radius: number; at?: [number, number, number] }

interface Ring { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; locked: boolean; flash: number }

const HELD = '#8d97a6'

export class PartHalos {
  private rings = new Map<string, Ring>()

  constructor(private pivot: (unit: number, part: string) => PartPivot | null) {}

  /**
   * This frame's rings: for each unit, the parts driven, those locked and its holder's colour. True while any ring is
   * showing (the stage keeps drawing).
   */
  update(units: readonly { parts: readonly string[]; locks: ReadonlySet<string>; color: string | null }[], t: number, dt: number): boolean {
    const want = new Set<string>()
    units.forEach((u, n) => {
      if (!u.color) return
      for (const part of u.parts) if (!u.locks.has(part)) this.ring(n, part, false, u.color, want)
      for (const part of u.locks) this.ring(n, part, true, HELD, want)
    })
    for (const [key, r] of this.rings) {
      if (want.has(key)) continue
      r.mesh.removeFromParent()
      r.mesh.geometry.dispose()
      r.mat.dispose()
      this.rings.delete(key)
    }
    const breath = 0.5 + 0.5 * Math.sin(t * 3.2)
    for (const r of this.rings.values()) {
      r.flash = Math.max(0, r.flash - dt / 0.45)
      r.mat.opacity = r.locked ? 0.28 : 0.42 + 0.3 * breath + 0.4 * r.flash
      r.mesh.scale.setScalar(1 + 0.35 * r.flash)
    }
    return this.rings.size > 0
  }

  private ring(unit: number, part: string, locked: boolean, color: string, want: Set<string>) {
    const key = `${unit}:${part}`
    const at = this.pivot(unit, part)
    if (!at) return
    want.add(key)
    let r = this.rings.get(key)
    if (r && r.locked !== locked) { r.mesh.removeFromParent(); r.mesh.geometry.dispose(); r.mat.dispose(); r = undefined; this.rings.delete(key) }
    if (!r) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(at.radius, Math.max(0.006, at.radius * 0.045), 8, 64), mat)
      // The torus lies across z: turn it so it rings the part's own axis.
      if (at.axis === 'x') mesh.rotation.y = Math.PI / 2
      else if (at.axis === 'y') mesh.rotation.x = Math.PI / 2
      if (at.at) mesh.position.set(...at.at)
      mesh.renderOrder = 3
      mesh.name = `part-halo-${key}`
      at.object.add(mesh)
      r = { mesh, mat, locked, flash: locked ? 0 : 1 }
      this.rings.set(key, r)
    }
    r.mat.color.set(color)
  }

  clear() { this.update([], 0, 0) }
}
