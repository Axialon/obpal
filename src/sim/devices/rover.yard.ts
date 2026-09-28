import { contactSurface } from '../contact'
/** The rover's hard-surface yard. Course dimensions still come from the driving model. */
import * as THREE from 'three'
import { batch } from '../kit'
import { carbon, ceramic, darkTitanium, gunmetal, lime } from '../kit/surfaces'
import { CONE_R, GATES, RAMPS } from './rover'
import { blobShadow } from './view'

const DETAIL = .0005, HOUSING = .002, SEAM = .0015

/** A clipped planar panel, with one narrow 45-degree chamfer and flat face normals. */
function panel(w: number, h: number, d: number, material: THREE.Material, edge = HOUSING, opening?: readonly [number, number]) {
  const x = w / 2 - edge, y = h / 2 - edge, c = Math.min(Math.min(w, h) * .12, .015)
  const shape = new THREE.Shape()
  shape.moveTo(-x + c, -y); shape.lineTo(x - c, -y); shape.lineTo(x, -y + c); shape.lineTo(x, y - c)
  shape.lineTo(x - c, y); shape.lineTo(-x + c, y); shape.lineTo(-x, y - c); shape.lineTo(-x, -y + c); shape.closePath()
  if (opening) {
    const [w,h] = opening, hole = new THREE.Path(), x = w/2, y = h/2, c = .015
    hole.moveTo(-x+c,-y); hole.lineTo(-x,-y+c); hole.lineTo(-x,y-c); hole.lineTo(-x+c,y)
    hole.lineTo(x-c,y); hole.lineTo(x,y-c); hole.lineTo(x,-y+c); hole.lineTo(x-c,-y); hole.closePath(); shape.holes.push(hole)
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: d - 2 * edge, steps: 1, bevelEnabled: true, bevelThickness: edge, bevelSize: edge, bevelSegments: 1, curveSegments: 1 })
  geometry.translate(0, 0, -d / 2 + edge)
  const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true
  return mesh
}

function deck(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number, edge = HOUSING, opening?: readonly [number, number]) {
  const m = panel(w, h, d, material, edge, opening); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z)
  return contactSurface(m)
}

/** Neutral access inlays sit flush, with the same physical seam as the model panels. */
function inlay(g: THREE.Group, w: number, h: number, x: number, y: number, z: number) {
  g.add(deck(w + SEAM * 2, h + SEAM * 2, .002, carbon, x, y - .002, z, DETAIL))
  g.add(deck(w, h, .003, ceramic, x, y - .0015, z, DETAIL))
}

export function buildYard(hx: number, hz: number) {
  const group = new THREE.Group()
  const pad = gunmetal.clone(); pad.roughness = .30
  const edge = lime.clone()
  group.add(deck(hx * 2 + .3, hz * 2 + .3, .04, carbon, 0, -.024, 0))
  const cols = Math.ceil(hx), rows = Math.ceil(hz), w = hx * 2 / cols, h = hz * 2 / rows
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const x = -hx + w * (i + .5), z = -hz + h * (j + .5)
    const service = i === 1 || i === cols - 2
    group.add(deck(w - SEAM, h - SEAM, .008, pad, x, -.004, z, HOUSING, service ? [w * .20 + SEAM * 2, h * .78 + SEAM * 2] : undefined))
    // Service lanes share the floor grid and stay clear of the ramp's centreline.
    if (service) inlay(group, w * .20, h * .78, x, 0, z)
  }
  for (const side of [-1, 1]) {
    for (const [length, x, z, turn] of [[hx * 2, 0, side * hz, 0], [hz * 2, side * hx, 0, Math.PI / 2]]) {
      const wall = panel(length, .22, .02, darkTitanium); wall.position.set(x, .11, z); wall.rotation.y = turn; group.add(wall)
      const count = Math.max(1, Math.floor(length / 2.5))
      for (let i = 0; i < count; i++) {
        const t = length * ((i + .5) / count - .5)
        const strip = panel(.64, .085, .004, ceramic, DETAIL)
        strip.position.set(x + Math.cos(turn) * t, .12, z - Math.sin(turn) * t)
        strip.position.x += Math.sin(turn) * -side * .011
        strip.position.z += Math.cos(turn) * -side * .011
        strip.rotation.y = turn; group.add(strip)
      }
      for (const t of [-length * .39, length * .39]) {
        const slit = panel(.16, .008, .003, edge, DETAIL)
        slit.position.set(x + Math.cos(turn) * t + Math.sin(turn) * -side * .011, .19, z - Math.sin(turn) * t + Math.cos(turn) * -side * .011)
        slit.rotation.y = turn; group.add(slit)
      }
    }
  }
  batch(group)
  return { group, pad, edge }
}

/** A clipped square cone: the original radius, height and movable contact shadow. */
export function buildCone() {
  const g = new THREE.Group(); g.scale.setScalar(CONE_R / .09)
  g.add(deck(.17, .17, .02, carbon, 0, .01, 0), blobShadow(.1, .35))
  const profile = [[.02,.073],[.022,.075],[.125,.041],[.16,.029],[.256,.008],[.26,.006]]
  for (let j = 0; j < profile.length - 1; j++) {
    const [y0,r0] = profile[j], [y1,r1] = profile[j + 1]
    const points = (r: number, y: number) => [[-.7,-1],[.7,-1],[1,-.7],[1,.7],[.7,1],[-.7,1],[-1,.7],[-1,-.7]].map(([x,z]) => new THREE.Vector3(x*r,y,z*r))
    const ring = [...points(r0,y0), ...points(r1,y1)], vertices: number[] = []
    for (let i = 0; i < 8; i++) { const k = (i+1)%8; for (const n of [i,i+8,k,k,i+8,k+8]) vertices.push(...ring[n].toArray()) }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices,3)); geometry.computeVertexNormals()
    const m = new THREE.Mesh(geometry,j === 2 ? ceramic : darkTitanium); m.receiveShadow = true; g.add(m)
  }
  batch(g)
  return g
}

export function buildCourse() {
  const g = new THREE.Group()
  for (const r of RAMPS) {
    const shape = new THREE.Shape()
    shape.moveTo(-r.halfLength, 0); shape.lineTo(-r.halfLength / 2, r.height); shape.lineTo(r.halfLength / 2, r.height); shape.lineTo(r.halfLength, 0); shape.closePath()
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: r.halfWidth * 2 - HOUSING * 2, bevelEnabled: true, bevelSize: HOUSING, bevelThickness: HOUSING, bevelSegments: 1, steps: 1 })
    const ramp = new THREE.Mesh(geometry, gunmetal); ramp.rotation.y = -Math.PI / 2; ramp.position.set(r.x + r.halfWidth - HOUSING, -HOUSING, r.z); ramp.receiveShadow = true; g.add(contactSurface(ramp))
    for (const side of [-1, 1]) {
      // Straight inset strips follow the actual deck planes, including each incline.
      for (const section of [-1, 0, 1]) {
        const run = section ? r.halfLength / 2 : r.halfLength
        const rise = section ? r.height : 0, length = Math.hypot(run, rise)
        const z = r.z + section * r.halfLength * .75, y = section ? r.height / 2 : r.height
        const rail = deck(.045, length - SEAM, .003, ceramic, r.x + side * (r.halfWidth - .12), y - .001, z, DETAIL)
        rail.rotation.x += Math.atan2(section * rise, run); g.add(rail)
      }
      const access = panel(.58,.13,.004,ceramic,DETAIL); access.rotation.y=Math.PI/2
      access.position.set(r.x+side*(r.halfWidth-.001),r.height*.45,r.z); g.add(access)
    }
  }
  for (const gate of GATES) {
    for (const side of [-1, 1]) {
      const post = panel(.11,1.35,.11,darkTitanium); post.position.set(gate.x+side*gate.width/2,.675,gate.z); g.add(post)
      const insert = panel(.055,.72,.004,ceramic,DETAIL); insert.position.set(post.position.x,.76,gate.z+.055); g.add(insert)
    }
    const bar = panel(gate.width+.12,.1,.12,gunmetal); bar.position.set(gate.x,1.32,gate.z); g.add(bar)
    const status = panel(.18,.008,.003,lime,DETAIL); status.position.set(gate.x,1.32,gate.z+.061); g.add(status)
  }
  for (let i = 0; i < 32; i++) {
    const a = i / 32 * Math.PI * 2
    const dash = deck(.05,.38,.003,ceramic,Math.cos(a)*7.8,-.001,Math.sin(a)*4.7,DETAIL); dash.rotation.z = -a; g.add(dash)
  }
  batch(g); return g
}

export function bay(x: number, z: number) {
  const g = new THREE.Group()
  for (const side of [-1,1]) g.add(deck(.028,.9,.003,ceramic,x+side*.42,-.001,z,DETAIL))
  batch(g); return g
}
