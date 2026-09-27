/**
 * Cards on the sim catalogue for the sims that aren't devices: the faction arena (pucks in their players' colours on the
 * glowing ring) and the Viewer's shared scene (a model whose parts people hold, each in their colour).
 */
import * as THREE from 'three'
import { floorMaterial, plastic } from './kit'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { previewScene, type Preview } from './devices/view'

/** The shared-scene colours (PARTICIPANT_COLORS in @obpal/host): sky, rose, amber, mint. */
const PEOPLE = ['#38bdf8', '#fb7185', '#fcd34d', '#6ee7b7']

export function arenaPreview(): Preview {
  const scene = previewScene()
  const R = 1.2
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.06, 96), floorMaterial())
  disc.position.y = -0.03
  const edge = new THREE.Mesh(new THREE.TorusGeometry(R, 0.014, 10, 160), new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: '#c6ff34', emissiveIntensity: 1.2 }))
  edge.rotation.x = Math.PI / 2
  scene.add(disc, edge)
  const pucks = PEOPLE.map((c) => {
    const g = new THREE.Group()
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.135, 0.06, 48), new THREE.MeshStandardMaterial({ color: '#171c25', metalness: 0.7, roughness: 0.3 }))
    body.position.y = 0.03
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.133, 0.011, 10, 64), new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: c, emissiveIntensity: 2.2 }))
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.062
    g.add(body, ring)
    scene.add(g)
    return g
  })
  const camera = new THREE.PerspectiveCamera(36, 16 / 10, 0.05, 40)
  camera.position.set(0, 2.4, 2.1)
  camera.lookAt(0, 0, 0.05)
  return {
    scene, camera,
    step(t) {
      pucks.forEach((p, i) => {
        const a = t * (0.45 + i * 0.08) + (i * Math.PI) / 2
        const r = 0.45 + 0.28 * Math.sin(t * 0.9 + i * 1.7)
        p.position.set(Math.cos(a) * r, 0, Math.sin(a) * r)
      })
    },
  }
}

export function viewerPreview(): Preview {
  const scene = previewScene()
  const model = new THREE.Group()
  scene.add(model)
  const body = plastic()
  const base = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.34, 0.9, 4, 0.07), body)
  base.position.y = 0.17
  const lid = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.1, 0.9, 4, 0.04), body)
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 40, 28), new THREE.MeshPhysicalMaterial({ color: '#b3a4ff', metalness: 0.1, roughness: 0.15, clearcoat: 1 }))
  const knob = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 16, 64), new THREE.MeshStandardMaterial({ color: '#c9d1dc', metalness: 0.85, roughness: 0.28 }))
  model.add(base, lid, orb, knob)
  // Each held part wears its holder's colour as a halo.
  const halo = (c: string, r: number) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.008, 8, 96), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9 }))
    m.rotation.x = Math.PI / 2
    return m
  }
  const halos = [halo(PEOPLE[0], 0.66), halo(PEOPLE[1], 0.24), halo(PEOPLE[2], 0.24)]
  lid.add(halos[0])
  orb.add(halos[1])
  knob.add(halos[2])
  halos[2].rotation.x = 0
  const camera = new THREE.PerspectiveCamera(34, 16 / 10, 0.05, 40)
  camera.position.set(0, 1.35, 2.5)
  camera.lookAt(0, 0.45, 0)
  return {
    scene, camera,
    step(t) {
      model.rotation.y = t * 0.35
      const lift = 0.5 + 0.5 * Math.sin(t * 1.1)
      lid.position.set(0, 0.39 + lift * 0.34, 0)
      lid.rotation.y = lift * 0.6
      orb.position.set(Math.cos(t * 0.8) * 0.72, 0.62 + Math.sin(t * 1.6) * 0.1, Math.sin(t * 0.8) * 0.72)
      knob.position.set(-0.62, 0.3 + lift * 0.18, 0.1)
      knob.rotation.set(t * 0.9, 0, t * 0.4)
    },
  }
}
