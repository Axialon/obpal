/** Community packs are bounded data, never executable extensions (spec/PACKS.md). */
import { checkProfile, CONTROLLERS, isControllerId, type ControllerId, type ProfileSpec } from './catalogue'
import { checkButtons } from './buttons'

export const PACK_VERSION = '1.0.0'
export const PACK_KINDS = ['profile', 'mapping', 'mode', 'scene-link', 'controller-layout', 'experience'] as const
export const PACK_LICENSES = ['MIT', 'CC-BY-4.0', 'CC0-1.0'] as const
export const PACK_LIMITS = { bytes: 64 * 1024, previewBytes: 256 * 1024, catalogueBytes: 2 * 1024 * 1024, packs: 512, frames: 120, joints: 64, duration: 30 } as const
export const PACK_ID = /^[a-z][a-z0-9-]{1,31}\/[a-z][a-z0-9-]{1,31}$/
export const PACK_SEMVER = /^(?=.{1,64}$)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export interface ModeBody { rig: string; duration: number; frames: { at: number; joints: Record<string, number> }[] }
export type MappingOutput = { kind: 'key'; code: string } | { kind: 'mouse'; button: 0 | 1 | 2 } | { kind: 'gamepad'; button: number }
export interface MappingBody { site: string; controller: ControllerId; controls: Record<string, MappingOutput>; buttons?: Record<string, string> }
export const PACK_KEY_CODE = /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Enter|Escape|Tab|Backspace|Delete|Home|End|Page(Up|Down)|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|F([1-9]|1[0-2]))$/
export interface PackBodies {
  profile: ProfileSpec
  mapping: MappingBody
  mode: ModeBody
  'scene-link': { url: string }
  'controller-layout': { controllers: ControllerId[]; profile?: string }
  experience: { packs: { id: string; version: string }[] }
}
export type Pack<K extends keyof PackBodies = keyof PackBodies> = K extends keyof PackBodies ? {
  id: string; version: string; kind: K; name: string; description: string
  author: { name: string; url?: string }; license: typeof PACK_LICENSES[number]
  source?: string; attribution: string; requires: { catalogue: string; controllers: ControllerId[] }
  preview?: { url: string; bytes: number }; created: string; deprecated?: { reason: string; replacement?: string }
  body: PackBodies[K]
} : never
export interface PackContext { rigs?: Record<string, Readonly<Record<string, readonly [number, number]>>> }
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const https = (v: unknown) => {
  try { const u = new URL(String(v)); return typeof v === 'string' && !/[<>\s]/.test(v) && u.protocol === 'https:' && !u.username && !u.password && v.length <= 500 } catch { return false }
}
/** Displayed pack text must not impersonate the project or contain markup. The copy guard checks further claims. */
export const packTextProblem = (s: string) => /[<>\r\n]|\bofficial\b|\b(?:approved|endorsed|certified|verified)\s+(?:by\s+)?ob[. ]?pal\b|\bob[. ]?pal\s+(?:approved|endorsed|certified|verified)\b/i.test(s)

/** Validate the envelope and kind body. Modes require the consumer's maintained joint limits, never pack limits. */
export function checkPack(x: unknown, context: PackContext = {}): { pack: Pack | null; errors: string[] } {
  const errors: string[] = []
  let encoded: string
  try { encoded = JSON.stringify(x) ?? ''; if (new TextEncoder().encode(encoded).length > PACK_LIMITS.bytes) return { pack: null, errors: ['pack: at most 64 KiB'] } } catch { return { pack: null, errors: ['pack: JSON data required'] } }
  const o = object(x)
  const keys = (v: Record<string, unknown>, allowed: string[], path: string) => {
    for (const k of Object.keys(v)) if (!allowed.includes(k)) errors.push(`${path}.${k}: unknown field`)
  }
  const text = (v: unknown, max: number, path: string) => {
    if (typeof v !== 'string' || !v.trim() || v.length > max || packTextProblem(v)) errors.push(`${path}: plain text, 1 to ${max} characters, without project status claims`)
  }
  const controllers = (v: unknown, path: string) => {
    if (!Array.isArray(v) || v.length > 9 || new Set(v).size !== v.length || v.some((c) => !isControllerId(c))) errors.push(`${path}: unique known controllers`)
  }
  keys(o, ['id', 'version', 'kind', 'name', 'description', 'author', 'license', 'source', 'attribution', 'requires', 'preview', 'created', 'deprecated', 'body'], 'pack')
  if (typeof o.id !== 'string' || !PACK_ID.test(o.id)) errors.push('id: author/name, lowercase, 2 to 32 characters per part')
  if (typeof o.version !== 'string' || !PACK_SEMVER.test(o.version)) errors.push('version: semver')
  for (const k of ['id', 'version']) if (typeof o[k] === 'string' && packTextProblem(o[k] as string)) errors.push(`${k}: no project status claims`)
  if (!(PACK_KINDS as readonly unknown[]).includes(o.kind)) errors.push('kind: unknown')
  text(o.name, 40, 'name'); text(o.description, 240, 'description'); text(o.attribution, 160, 'attribution')
  const author = object(o.author)
  keys(author, ['name', 'url'], 'author'); text(author.name, 80, 'author.name')
  if (typeof author.name === 'string' && /^ob[. ]?pal$/i.test(author.name.trim()) && !(typeof o.id === 'string' && o.id.startsWith('obpal/'))) errors.push('author.name: ob.Pal credit is reserved for maintained obpal/ examples')
  if (typeof o.id === 'string' && o.id.startsWith('obpal/') && author.name !== 'ob.Pal') errors.push('id: obpal/ is reserved for maintained ob.Pal examples')
  if (author.url !== undefined && !https(author.url)) errors.push('author.url: https URL')
  if (!(PACK_LICENSES as readonly unknown[]).includes(o.license)) errors.push('license: MIT, CC-BY-4.0 or CC0-1.0')
  if (o.source !== undefined && !https(o.source)) errors.push('source: https URL')
  if (typeof o.created !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.created) || !Number.isFinite(Date.parse(o.created)) || new Date(o.created).toISOString().slice(0, 10) !== o.created) errors.push('created: calendar date YYYY-MM-DD')
  const requires = object(o.requires)
  keys(requires, ['catalogue', 'controllers'], 'requires')
  if (requires.catalogue !== PACK_VERSION) errors.push(`requires.catalogue: supported version ${PACK_VERSION}`)
  controllers(requires.controllers, 'requires.controllers')
  if (o.preview !== undefined) {
    const p = object(o.preview); keys(p, ['url', 'bytes'], 'preview')
    if (typeof p.url !== 'string' || !/^\/packs\/previews\/[a-z0-9-]+\.(png|jpg|webp)$/.test(p.url)) errors.push('preview.url: local raster under /packs/previews/')
    if (!Number.isInteger(p.bytes) || (p.bytes as number) < 1 || (p.bytes as number) > PACK_LIMITS.previewBytes) errors.push('preview.bytes: 1 to 256 KiB')
  }
  if (o.deprecated !== undefined) {
    const d = object(o.deprecated); keys(d, ['reason', 'replacement'], 'deprecated'); text(d.reason, 160, 'deprecated.reason')
    if (d.replacement !== undefined && (typeof d.replacement !== 'string' || !PACK_ID.test(d.replacement))) errors.push('deprecated.replacement: pack id')
  }
  const b = object(o.body)
  for (const target of Object.values(object(b.buttons))) if (typeof target === 'string' && /[<>\r\n]/.test(target)) errors.push('body.buttons: no markup')
  const needs = (c: unknown) => { if (!Array.isArray(requires.controllers) || !requires.controllers.includes(c)) errors.push('requires.controllers: include the body controller') }
  switch (o.kind) {
    case 'profile': {
      keys(b, ['id', 'name', 'for', 'on', 'aim', 'steer', 'point', 'controller', 'buttons'], 'body')
      for (const k of ['aim', 'steer', 'point']) keys(object(b[k]), ['route', 'gain', 'curve', 'deadzone', 'invertY', 'edgeTurn'], `body.${k}`)
      errors.push(...checkProfile(b).errors.map((e) => `body.${e}`))
      if (Array.isArray(b.on) && new Set(b.on).size !== b.on.length) errors.push('body.on: unique utilities')
      if (typeof o.id === 'string' && b.id !== o.id.split('/')[1]) errors.push('body.id: match the pack name')
      text(b.name, 40, 'body.name'); text(b.for, 120, 'body.for'); needs(b.controller ?? 'face.gamepad'); break
    }
    case 'mapping':
      keys(b, ['site', 'controller', 'controls', 'buttons'], 'body')
      if (typeof b.site !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(b.site) || b.site.length > 253) errors.push('body.site: host name')
      if (!isControllerId(b.controller)) errors.push('body.controller: known controller')
      else if (b.buttons !== undefined) errors.push(...checkButtons(b.controller, b.buttons).errors.map((e) => `body.${e}`))
      if (!Object.keys(object(b.controls)).length || Object.keys(object(b.controls)).length > 64) errors.push('body.controls: 1 to 64 controller-to-output bindings')
      for (const [control, value] of Object.entries(object(b.controls))) {
        if (!isControllerId(b.controller) || !CONTROLLERS[b.controller].controls.includes(control)) errors.push(`body.controls.${control}: a control on the maintained controller`)
        const target = object(value)
        keys(target, target.kind === 'key' ? ['kind', 'code'] : ['kind', 'button'], `body.controls.${control}`)
        if (target.kind === 'key') {
          if (typeof target.code !== 'string' || !PACK_KEY_CODE.test(target.code)) errors.push(`body.controls.${control}.code: a supported physical key code`)
        } else if (target.kind === 'mouse' || target.kind === 'gamepad') {
          if (!Number.isInteger(target.button) || (target.button as number) < 0 || (target.button as number) > (target.kind === 'mouse' ? 2 : 16)) errors.push(`body.controls.${control}.button: a standard ${target.kind} button`)
        } else errors.push(`body.controls.${control}: key, mouse or gamepad output`)
      }
      needs(b.controller); break
    case 'mode': {
      keys(b, ['rig', 'duration', 'frames'], 'body')
      const limits = typeof b.rig === 'string' && context.rigs && Object.prototype.hasOwnProperty.call(context.rigs, b.rig) ? context.rigs[b.rig] : undefined
      if (!limits) errors.push('body.rig: maintained joint profile required')
      if (typeof b.duration !== 'number' || !Number.isFinite(b.duration) || b.duration <= 0 || b.duration > PACK_LIMITS.duration) errors.push('body.duration: 0 to 30 seconds')
      if (!Array.isArray(b.frames) || b.frames.length < 2 || b.frames.length > PACK_LIMITS.frames) errors.push('body.frames: 2 to 120 frames')
      let previous = -1
      let jointNames: string | undefined
      for (const [i, frame] of (Array.isArray(b.frames) ? b.frames.slice(0, PACK_LIMITS.frames) : []).entries()) {
        const f = object(frame); keys(f, ['at', 'joints'], `body.frames.${i}`)
        if (typeof f.at !== 'number' || !Number.isFinite(f.at) || f.at <= previous || f.at < 0 || f.at > (b.duration as number)) errors.push(`body.frames.${i}.at: increasing time within duration`)
        previous = f.at as number
        const joints = object(f.joints)
        const names = Object.keys(joints).sort().join(',')
        if (jointNames !== undefined && names !== jointNames) errors.push('frame.joints: use the same named joints in every frame')
        jointNames = names
        if (!Object.keys(joints).length || Object.keys(joints).length > PACK_LIMITS.joints) errors.push('frame.joints: 1 to 64 named joints')
        for (const [id, angle] of Object.entries(joints)) {
          const range = limits && Object.prototype.hasOwnProperty.call(limits, id) ? limits[id] : undefined
          if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1] || typeof angle !== 'number' || !Number.isFinite(angle) || angle < range[0] || angle > range[1]) errors.push(`frame.joints.${id}: within maintained profile limits (radians)`)
        }
      }
      if (Array.isArray(b.frames) && (object(b.frames[0]).at !== 0 || object(b.frames.at(-1)).at !== b.duration)) errors.push('body.frames: start at 0 and end at duration')
      break
    }
    case 'scene-link': keys(b, ['url'], 'body'); if (!https(b.url)) errors.push('body.url: https URL'); break
    case 'controller-layout':
      keys(b, ['controllers', 'profile'], 'body'); controllers(b.controllers, 'body.controllers')
      if (!Array.isArray(b.controllers) || !b.controllers.length) errors.push('body.controllers: at least one controller')
      for (const c of Array.isArray(b.controllers) ? b.controllers : []) needs(c)
      if (b.profile !== undefined && (typeof b.profile !== 'string' || !PACK_ID.test(b.profile))) errors.push('body.profile: pack id')
      break
    case 'experience':
      keys(b, ['packs'], 'body')
      if (!Array.isArray(b.packs) || !b.packs.length || b.packs.length > 16) errors.push('body.packs: 1 to 16 versioned packs')
      for (const ref of Array.isArray(b.packs) ? b.packs.slice(0, 16) : []) {
        const r = object(ref); keys(r, ['id', 'version'], 'body.packs')
        if (Array.isArray(b.packs) && b.packs.filter((ref) => object(ref).id === r.id && object(ref).version === r.version).length > 1) errors.push('body.packs: unique references')
        if (typeof r.id !== 'string' || !PACK_ID.test(r.id) || r.id === o.id || typeof r.version !== 'string' || !PACK_SEMVER.test(r.version)) errors.push('body.packs: valid id and exact version, no self reference')
      }
      break
  }
  return { pack: errors.length ? null : JSON.parse(encoded) as Pack, errors }
}

export const packCredit = (p: Pack) => `by ${p.author.name} · ${p.license}`
/** Stable wire profile ids fit the existing protocol; the pack id remains the storage and selection key. */
export const packProfileId = (p: Pack<'profile'>) => {
  let hash = 2166136261
  for (const c of p.id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619)
  return `pack-${p.body.id.slice(0, 18)}-${(hash >>> 0).toString(36)}`
}

/** Load an interruptible simulation preset with the consumer's own profile. Physical drivers never accept it. */
export function loadModePack(x: unknown, rig: { id: string; joints: readonly { id: string; limits: readonly [number, number] }[] }, physical = false) {
  if (physical) return { pack: null, errors: ['Mode packs cannot drive physical systems'] }
  const checked = checkPack(x, { rigs: { [rig.id]: Object.fromEntries(rig.joints.map((j) => [j.id, j.limits])) } })
  return checked.pack?.kind === 'mode' ? { pack: checked.pack, errors: [] } : { pack: null, errors: checked.errors.length ? checked.errors : ['mode: wrong kind'] }
}

/** Linearly interpolate named joints only; the host still owns neutral, rate limits and interruption. */
export function modePackPose(pack: Pack<'mode'>, seconds: number): Record<string, number> {
  const frames = pack.body.frames
  const t = Math.max(0, Math.min(pack.body.duration, Number.isFinite(seconds) ? seconds : 0))
  const end = frames.findIndex((f) => f.at >= t)
  if (end <= 0) return { ...frames[end < 0 ? frames.length - 1 : 0].joints }
  const a = frames[end - 1], b = frames[end], phase = (t - a.at) / (b.at - a.at)
  return Object.fromEntries(Object.entries(b.joints).map(([id, angle]) => [id, (a.joints[id] ?? 0) * (1 - phase) + angle * phase]))
}
