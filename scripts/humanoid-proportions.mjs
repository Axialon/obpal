/** Measure the soft humanoids' rest proportions and shoe fit against humanoid-forms.json.
 *
 * node scripts/humanoid-proportions.mjs [--json]
 * Prints one row per form (hero and distant shoe fit) and writes proportions.json
 * to a new temporary folder; it never writes into the repository.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { readModel } from '../assets/blender/read-model.mjs'
import { measure, shoe } from '../assets/blender/proportions.mjs'
import { SOFT_PROFILES } from '../src/sim/humanoid/profile.ts'

const spec = JSON.parse(readFileSync(new URL('../assets/blender/humanoid-forms.json', import.meta.url), 'utf8'))
await MeshoptDecoder.ready
const load = async (name) => (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(readModel(name), '')).scene
const rows = []
let failures = 0
for (const profile of Object.values(SOFT_PROFILES).flat()) {
  const form = spec.forms[profile.model.endsWith('-ii') ? 'ii' : 'i']
  const m = measure(await load(profile.model), profile)
  const fits = [shoe(await load(profile.model), profile), shoe(await load(`${profile.model}-lod`), profile)]
  const misses = Object.entries(form).filter(([key, range]) => Array.isArray(range) && key in m && (m[key] < range[0] || m[key] > range[1])).map(([key]) => key)
  if (m.headDepthRatio < form.headDepthRatio) misses.push('headDepthRatio')
  for (const fit of fits) {
    if (Math.abs(fit.min[1] - fit.box.min[1]) > spec.shoe.soleTolerance) misses.push('sole')
    if (fit.lengthCoverage < spec.shoe.lengthCoverage) misses.push('shoeLength')
    if (fit.toeSpring > spec.shoe.toeSpring) misses.push('toeSpring')
  }
  failures += misses.length
  rows.push({ model: profile.model, ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, +v.toFixed(4)])),
    shoeCoverage: +fits[0].lengthCoverage.toFixed(3), soleOffset: +(fits[0].min[1] - fits[0].box.min[1]).toFixed(4), misses })
}
const out = mkdtempSync(join(tmpdir(), 'obpal-humanoid-proportions-'))
writeFileSync(join(out, 'proportions.json'), JSON.stringify({ spec: spec.forms, rows }, null, 2))
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2))
else console.table(rows.map(({ misses, ...row }) => ({ ...row, misses: misses.join(' ') || 'none' })))
console.log(`Proportion evidence: ${out}`)
if (failures) process.exitCode = 1
