import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkPack, loadModePack, modePackPose, PACK_ID, PACK_LICENSES, PACK_SEMVER, packCredit, packProfileId, PROFILE_LIMITS, resolveProfileSpec, type Pack } from '@obpal/core'
import { HUMANOID } from '../src/sim/humanoid/profile'
import { readText, packFiles } from './devtools-node.mjs'
import { SITE_PROFILES } from '../extension/src/shared/sites'

const examples = packFiles().map((f) => JSON.parse(readText(f)) as Pack)
const profile = examples.find((p): p is Pack<'profile'> => p.kind === 'profile')!
const mode = examples.find((p): p is Pack<'mode'> => p.kind === 'mode')!
const mapping = examples.find((p): p is Pack<'mapping'> => p.kind === 'mapping')!
const scene = examples.find((p): p is Pack<'scene-link'> => p.kind === 'scene-link')!
const context = { rigs: { [HUMANOID.id]: Object.fromEntries(HUMANOID.joints.map((j) => [j.id, j.limits])) } }
const copy = <T>(p: T): T => structuredClone(p)
const draft = (p: Pack = profile) => copy(p) as unknown as Record<string, unknown>
const invalid = (p: unknown) => { const r = checkPack(p, context); expect(r.pack).toBeNull(); expect(r.errors.length).toBeGreaterThan(0); return r.errors.join('; ') }

describe('pack envelopes and examples', () => {
  it('checks every shipped pack and preserves attribution', () => {
    expect(examples).toHaveLength(4)
    for (const p of examples) {
      expect(checkPack(p, context)).toEqual({ pack: p, errors: [] })
      expect(packCredit(p)).toBe(`by ${p.author.name} · ${p.license}`)
      expect(p.attribution).toContain(p.author.name)
    }
    expect(SITE_PROFILES.some((s) => s.host === mapping.body.site)).toBe(true)
    expect(scene.body.url).toBe('https://obpal.blackboxes.net/embed/')
  })
  it.each(['id', 'version', 'kind', 'name', 'description', 'author', 'license', 'attribution', 'requires', 'created', 'body'])('requires %s', (key) => {
    const p = draft(); delete p[key]; invalid(p)
  })
  it.each([null, false, 3, [], 'pack', {}])('rejects a non-envelope %j', (p) => { invalid(p) })
  it.each(['owner/name', 'maker/head-turn', 'my-team/my-pack'])('accepts a namespaced id %s', (id) => {
    const p = copy(profile); p.id = id; p.author.name = 'Example author'; p.body.id = id.split('/')[1]; expect(checkPack(p, context).errors).toEqual([])
  })
  it('reserves the example namespace and rejects third-party project status claims', () => {
    invalid({ ...profile, author: { name: 'Community maker' } })
    const thirdParty = { ...profile, id: 'maker/crane', author: { name: 'Community maker' }, attribution: 'Crane by Community maker · MIT' }
    expect(checkPack(thirdParty, context).errors).toEqual([])
    invalid({ ...thirdParty, id: 'obpal/crane' })
    invalid({ ...thirdParty, description: 'Official ob.Pal controller' })
  })
  it.each(['crane', 'Owner/name', 'a/name', 'owner/a', 'owner/name/extra', 'owner/<script>', `owner/${'a'.repeat(33)}`])('rejects id %s', (id) => { expect(PACK_ID.test(id)).toBe(false); invalid({ ...profile, id }) })
  it.each(['1.0.0', '0.0.1', '2.3.4-rc.1', '1.2.3+build.7', '1.2.3-alpha.0+build'])('accepts semver %s', (version) => { expect(PACK_SEMVER.test(version)).toBe(true); expect(checkPack({ ...profile, version }, context).pack).not.toBeNull() })
  it.each(['1', '1.0', '01.0.0', '1.0.0-01', '1.0.0-', '1.0.0+'])('rejects semver %s', (version) => { invalid({ ...profile, version }) })
  it('bounds semver so a mode identity fits the existing control channel', () => { invalid({ ...profile, version: `1.0.0-${'a'.repeat(65)}` }) })
  it.each(PACK_LICENSES)('accepts the approved SPDX licence %s', (license) => { expect(checkPack({ ...profile, license }, context).errors).toEqual([]) })
  it.each(['GPL-3.0', 'CC0', 'cc-by-4.0', 'proprietary', '', null])('rejects licence %s', (license) => { expect(invalid({ ...profile, license })).toContain('license') })
  it.each(['2026-02-30', '2026-13-01', 'yesterday', '2026-9-30', '2026-09-30T00:00:00Z'])('rejects date %s', (created) => { invalid({ ...profile, created }) })
  it.each(['name', 'description', 'attribution'])('bounds display field %s', (key) => {
    for (const value of ['', '   ', 9, 'x'.repeat(241), '<img src=x>', 'Official ob.Pal pack', 'ob.Pal approved', 'Verified by ob.Pal', 'text\nhtml']) invalid({ ...profile, [key]: value })
  })
  it('checks author credit, deprecation and nested extra fields', () => {
    invalid({ ...profile, author: { name: 'ob.Pal', role: 'maintainer' } })
    invalid({ ...profile, author: { name: 'Official ob.Pal' } })
    invalid({ ...profile, id: 'another/crane' })
    invalid({ ...profile, id: 'official/crane', author: { name: 'Example author' } })
    invalid({ ...profile, version: '1.0.0-official' })
    invalid({ ...profile, body: { ...profile.body, buttons: { 'key:Space': 'tray:<script>' } } })
    invalid({ ...profile, requires: { ...profile.requires, controllers: ['face.unknown'] } })
    invalid({ ...profile, requires: { ...profile.requires, controllers: ['face.gamepad', 'face.gamepad'] } })
    invalid({ ...profile, requires: { ...profile.requires, controllers: [] } })
    invalid({ ...profile, requires: { ...profile.requires, catalogue: '2.0.0' } })
    invalid({ ...profile, requires: { ...profile.requires, safety: false } })
    invalid({ ...profile, deprecated: { reason: '<b>old</b>' } })
    invalid({ ...profile, deprecated: { reason: 'Replaced', replacement: 'bad' } })
    expect(checkPack({ ...profile, deprecated: { reason: 'Replaced', replacement: 'obpal/new-crane' } }, context).errors).toEqual([])
  })
  it.each(['http://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:secret@example.com', 'file:///tmp/image'])('rejects URL %s in every external URL field', (url) => {
    invalid({ ...profile, source: url }); invalid({ ...profile, author: { name: 'Author', url } }); invalid({ ...scene, body: { url } })
  })
  it('rejects oversize JSON, multibyte bytes, cycles and invalid previews', () => {
    expect(invalid({ ...profile, payload: 'x'.repeat(65536) })).toContain('64 KiB')
    expect(invalid({ ...profile, payload: '界'.repeat(22000) })).toContain('64 KiB')
    const p = draft(); p.self = p; invalid(p)
    for (const preview of [{ url: 'https://example.com/a.png', bytes: 50 }, { url: '/packs/previews/a.svg', bytes: 50 }, { url: '/packs/previews/../a.png', bytes: 50 }, { url: '/packs/previews/a.png', bytes: 262145 }, { url: '/packs/previews/a.png', bytes: 0 }, { url: '/packs/previews/a.png', bytes: 1.5 }]) invalid({ ...profile, preview })
    expect(checkPack({ ...profile, preview: { url: '/packs/previews/a.webp', bytes: 262144 } }, context).errors).toEqual([])
  })
})

describe('per-kind bounds and maintained capabilities', () => {
  it('reuses profile validation, keeping routes, bindings and overrides bounded', () => {
    invalid({ ...profile, body: { ...profile.body, aim: { ...profile.body.aim, gain: 5 } } })
    invalid({ ...profile, body: { ...profile.body, steer: { ...profile.body.steer, route: 'mouse' } } })
    invalid({ ...profile, body: { ...profile.body, controller: 'face.new' } })
    invalid({ ...profile, body: { ...profile.body, on: ['motion.point', 'motion.point'] } })
    invalid({ ...profile, body: { ...profile.body, name: 'Official ob.Pal' } })
    invalid({ ...profile, body: { ...profile.body, buttons: { 'key:Space': '<script>' } } })
    const p = resolveProfileSpec(profile.body, { aim: { gain: 90, deadzone: -1 }, steer: { route: 'mouse' } })
    expect(p.aim.gain).toBe(4); expect(p.aim.deadzone).toBe(0); expect(p.steer.route).toBe(profile.body.steer.route)
    expect(PROFILE_LIMITS.id.test(packProfileId(profile))).toBe(true)
    expect(packProfileId({ ...profile, id: 'different/crane' })).not.toBe(packProfileId(profile))
  })
  it.each(['limits', 'driver', 'script', 'html', 'safety', 'velocity'])('rejects a limit-raising or executable field %s', (field) => {
    for (const p of examples) { invalid({ ...p, [field]: 100 }); invalid({ ...p, body: { ...p.body, [field]: 100 } }) }
    invalid({ ...profile, body: { ...profile.body, aim: { ...profile.body.aim, [field]: 100 } } })
    invalid({ ...mode, body: { ...mode.body, frames: mode.body.frames.map((f) => ({ ...f, [field]: 100 })) } })
  })
  it('checks mapping host, controller and input targets', () => {
    for (const body of [{ ...mapping.body, site: 'https://tesana.com' }, { ...mapping.body, controller: 'face.new' }, { ...mapping.body, buttons: { 'not-an-input': 'a' } }, { ...mapping.body, buttons: { 'key:Space': 'unknown' } }, { ...mapping.body, buttons: [] }]) invalid({ ...mapping, body })
  })
  it('checks control-to-site output mappings independently of optional phone bindings', () => {
    const controls = { a: { kind: 'key', code: 'Space' }, b: { kind: 'mouse', button: 0 }, menu: { kind: 'gamepad', button: 9 } }
    expect(checkPack({ ...mapping, body: { site: mapping.body.site, controller: mapping.body.controller, controls } }, context).errors).toEqual([])
    for (const controls of [{}, { unknown: { kind: 'key', code: 'Space' } }, { a: { kind: 'key', code: '<script>' } }, { a: { kind: 'mouse', button: 3 } }, { a: { kind: 'gamepad', button: 17 } }, { a: { kind: 'gamepad', button: 0.5 } }, { a: { kind: 'script', code: 'Space' } }, { a: { kind: 'key', code: 'Space', execute: true } }]) invalid({ ...mapping, body: { ...mapping.body, controls } })
  })
  it('accepts maintained joint limits, refuses physical playback and interpolates without mutating data', () => {
    const loaded = loadModePack(mode, HUMANOID)
    expect(loaded.errors).toEqual([])
    expect(modePackPose(loaded.pack!, 0.5)).toEqual({ 'head.yaw': 0.15 })
    expect(modePackPose(loaded.pack!, 10)).toEqual({ 'head.yaw': 0 })
    expect(loadModePack(mode, HUMANOID, true).pack).toBeNull()
    expect(loadModePack(profile, HUMANOID).pack).toBeNull()
    const a = modePackPose(mode, 0); a['head.yaw'] = 99
    expect(mode.body.frames[0].joints['head.yaw']).toBe(0)
    expect(checkPack(mode).errors.join()).toContain('maintained')
  })
  it.each(['unknown', 'head.yaw', 'head.pitch', 'toString', 'constructor', '__proto__'])('refuses missing joints or raised joint angles for %s', (joint) => {
    invalid({ ...mode, body: { ...mode.body, frames: [{ at: 0, joints: { [joint]: 999 } }, { at: 2, joints: { [joint]: 0 } }] } })
  })
  it('bounds frame count, shape, duration and time, and requires stable joints', () => {
    for (const body of [{ ...mode.body, rig: 'unknown' }, { ...mode.body, duration: 31 }, { ...mode.body, duration: 0 }, { ...mode.body, frames: [] }, { ...mode.body, frames: [mode.body.frames[0]] }, { ...mode.body, frames: Array(121).fill(mode.body.frames[0]) }, { ...mode.body, frames: [{ at: 0, joints: {} }, { at: 2, joints: {} }] }, { ...mode.body, frames: [{ at: 0, joints: { 'head.yaw': 0 } }, { at: 2, joints: { 'head.pitch': 0 } }] }, { ...mode.body, frames: [...mode.body.frames].reverse() }, { ...mode.body, frames: [{ at: 0, joints: { 'head.yaw': NaN } }, { at: 2, joints: { 'head.yaw': 0 } }] }]) invalid({ ...mode, body })
    const frame = copy(mode); frame.body.frames[1].at = 0; invalid(frame)
    frame.body.frames[1].at = 3; invalid(frame)
    frame.body.frames[1].at = Infinity; invalid(frame)
  })
  it('validates the deferred layout and experience bodies without fetching references', () => {
    const layout = { ...scene, kind: 'controller-layout', body: { controllers: ['face.gamepad'], profile: profile.id } }
    expect(checkPack(layout, context).errors).toEqual([])
    invalid({ ...layout, body: { controllers: ['face.unknown'] } })
    const ref = { id: profile.id, version: '1.0.0' }
    const experience = { ...scene, kind: 'experience', body: { packs: [ref] } }
    expect(checkPack(experience, context).errors).toEqual([])
    invalid({ ...experience, body: { packs: [] } }); invalid({ ...experience, body: { packs: [ref, ref] } })
    invalid({ ...experience, body: { packs: [{ id: experience.id, version: '1.0.0' }] } })
  })
})

describe('checked offline catalogue', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
  const catalogue = (community: unknown[] = examples) => JSON.stringify({ version: '1.0.0', community })
  it('rejects unsupported, duplicate, invalid and oversized catalogues', async () => {
    const { readPackCatalogue } = await import('../src/catalogue/packs')
    for (const text of ['null', '{}', JSON.stringify({ version: '2.0.0', community: [] }), catalogue([profile, profile]), catalogue([{ ...profile, license: 'bad' }]), 'x'.repeat(2 * 1024 * 1024 + 1)]) expect(() => readPackCatalogue(text)).toThrow()
  })
  it('loads fresh data, caches it, survives offline and rejects a bad update', async () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) })
    const fetcher = vi.fn().mockResolvedValue(new Response(catalogue()))
    vi.stubGlobal('fetch', fetcher)
    const library = await import('../src/catalogue/packs')
    expect(await library.loadCommunityPacks()).toEqual(examples)
    expect(data.get('obpal.packs.v1')).toContain(profile.attribution)
    fetcher.mockRejectedValue(new Error('offline'))
    expect(await library.loadCommunityPacks()).toEqual(examples)
    fetcher.mockResolvedValue(new Response(catalogue([{ ...profile, license: 'bad' }])))
    expect(await library.loadCommunityPacks()).toEqual(examples)
    expect(library.cachedPacks()).toEqual(examples)
  })
  it('handles unavailable storage and no network without preventing built-ins', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('private mode') }, setItem: () => { throw new Error('private mode') } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const library = await import('../src/catalogue/packs')
    expect(await library.loadCommunityPacks()).toEqual([])
  })
  it.each(['toString', 'constructor', '__proto__'])('refuses inherited rig names %s', (rig) => {
    invalid({ ...mode, body: { ...mode.body, rig, frames: [{ at: 0, joints: { toString: 999 } }, { at: 2, joints: { toString: 999 } }] } })
  })
  it('a community wheel profile uses its declared controller and returns to gamepad explicitly', async () => {
    const wheel: Pack<'profile'> = { ...profile, requires: { ...profile.requires, controllers: ['face.wheel'] }, body: { ...profile.body, controller: 'face.wheel' } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(catalogue([wheel]))))
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    const listens = { addEventListener() {}, removeEventListener() {} }
    vi.stubGlobal('document', { ...listens, documentElement: { classList: { toggle() {} } } })
    vi.stubGlobal('addEventListener', listens.addEventListener)
    vi.stubGlobal('screen', { orientation: { angle: 0 } })
    const library = await import('../src/catalogue/packs')
    await library.loadCommunityPacks()
    const { GamepadMode } = await import('../src/controller/gamepad')
    const { Motion } = await import('../src/controller/motion')
    const gamepad = new GamepadMode({ motion: new Motion(), settings: { gain: 1, smooth: 0.5 }, t0: 0, send: () => false, toast() {}, openSettings() {}, exit() {} })
    gamepad.setHost({ name: 'Example screen', profile: wheel.id })
    expect(gamepad.wheelInUse).toBe(true)
    expect(gamepad.profileInUse).toBe(packProfileId(wheel))
    gamepad.setWheel(false, false)
    await library.loadCommunityPacks()
    expect(gamepad.wheelInUse).toBe(false)
    expect(gamepad.profileInUse).toBe('default')
  })
})
