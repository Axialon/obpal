import { describe, expect, it } from 'vitest'
import { projectPublicArena, projectPublicCampaign, projectPublicCatalog, projectPublicFilmManifest, projectPublicFilmAssets } from '../scripts/lib/public-catalog.mjs'
import { inspectCatalog, inspectFilmAssets, readPublicSource } from './public-export-node.mjs'
import type { PublicExportPolicy } from '../scripts/lib/public-export.mjs'

const policy = { schema: 1, profile: 'public-demo-v1', catalog: {
  items: ['cube', 'knot', 'gem'], categories: ['studio', 'local'], defaultId: 'cube',
} } as PublicExportPolicy

describe('canonical catalogue public projection', () => {
  it('keeps the canonical development default/art while producing only the existing neutral shapes', async () => {
    const source = readPublicSource('src/viewer/catalog.ts')
    const before = await inspectCatalog(source), projected = projectPublicCatalog(source, policy)
    const after = await inspectCatalog(projected)
    if (before.defaultId === 'cvc-insignia') {
      expect(before.ids.length).toBeGreaterThan(3)
      expect(before.art.cvc.image).toBe('/models/cvc/icons/CVC_flat.svg')
    } else expect(before.defaultId).toBe('cube')
    expect(after.ids).toEqual(['cube', 'knot', 'gem'])
    expect(after.categories).toEqual(['studio', 'local'])
    expect(after.defaultId).toBe('cube')
    expect(Object.keys(after.art)).toEqual(['studio', 'local'])
    expect(after.diagnostics).toEqual([])
    expect(after.made).toEqual(['cube', 'knot', 'gem'])
    expect(projected).not.toMatch(/boxemCore|models\/(?:cvc|blackboxes)|cvc-insignia/)
    expect(source.slice(source.indexOf('function faceMark'))).toBe(projected.slice(projected.indexOf('function faceMark')))
    expect(readPublicSource('src/viewer/catalog.ts')).toBe(source)
  })

  it('is deterministic and idempotent without a second hand-maintained catalogue', () => {
    const source = readPublicSource('src/viewer/catalog.ts'), once = projectPublicCatalog(source, policy)
    expect(projectPublicCatalog(source, policy)).toBe(once)
    expect(projectPublicCatalog(once, policy)).toBe(once)
  })

  it('removes the development-only category image dependency from the shared consumer seam', () => {
    const main = readPublicSource('src/viewer/main.ts')
    expect(main).toContain('CATEGORY_ART as CAT_ART')
    expect(main).not.toContain('/models/cvc/icons/CVC_flat.svg')
    const projected = projectPublicCatalog(readPublicSource('src/viewer/catalog.ts'), policy)
    expect(projected).not.toContain('cvc-insignia')
    expect(projected).toMatch(/DEFAULT_ITEM\s*=\s*["']cube["']/)
  })

  it('fails closed for unknown profile, bindings, catalogue rows and malformed source', () => {
    const source = readPublicSource('src/viewer/catalog.ts')
    for (const changed of [source.replace('export const CATALOG:', 'export const UNKNOWN:'),
      source.replace("id: 'cube'", "id: 'unreviewed'"), source + '\nexport const surprise = 1', source + '\n{']) {
      expect(() => projectPublicCatalog(changed, policy)).toThrow()
    }
    expect(() => projectPublicCatalog(source, { ...policy, schema: 2 } as unknown as PublicExportPolicy)).toThrow()
  })

  it('rejects public row structures that can override its verified maker or model path', () => {
    const source = readPublicSource('src/viewer/catalog.ts')
    for (const extra of [", ...{ make: undefined, src: '/omitted.glb' }", ", ['src']: '/omitted.glb'", ', unexpected: true']) {
      expect(() => projectPublicCatalog(source.replace('make: orientationCube }', `make: orientationCube${extra} }`), policy)).toThrow()
    }
  })
})

describe('frozen generated-only consumer projections', () => {
  it('keeps native arena mechanics and pucks but removes restricted faction depictions and loader requests', () => {
    const source = readPublicSource('src/sim/arena.ts'), out = projectPublicArena(source)
    for (const name of ['Team 1', 'Team 2', 'Team 3', 'Team 4']) expect(out).toContain(name)
    expect(out).not.toMatch(/models\/cvc|GLTFLoader|loader\.load/)
    expect(out).toContain('new THREE.CylinderGeometry(PUCK')
    expect(out.slice(out.indexOf('const slotOf'))).toBe(source.slice(source.indexOf('const slotOf')))
    expect(projectPublicArena(out)).toBe(out)
    expect(readPublicSource('src/sim/arena.ts')).toBe(source)
    expect(() => projectPublicArena(source.replace('const FACTIONS', 'const UNKNOWN'))).toThrow()
    expect(() => projectPublicArena(source.includes('CVC_insignia.glb') ? source.replace('CVC_insignia.glb', 'unexpected.glb') : source.replace('Team 1', 'Unexpected'))).toThrow()
  })

  it('replaces only the known campaign film presentation with an honest omitted-media notice', () => {
    const source = readPublicSource('campaign/index.html'), out = projectPublicCampaign(source)
    expect(out).toContain('not included in this public demo')
    expect(out).not.toMatch(/<video\b|campaign\/films\/|Download MP4|Six complete films/)
    expect(out).toContain('id="film-surface"')
    expect(out).toContain('/src/pages/partner-films.ts')
    expect(projectPublicCampaign(out)).toBe(out)
    expect(readPublicSource('campaign/index.html')).toBe(source)
    expect(() => projectPublicCampaign(source.replace('class="film-grid"', 'class="unknown-grid"'))).toThrow()
  })

  it('keeps a compatible empty film inventory, refusing unknown source structure', () => {
    const source = readPublicSource('public/campaign/films/manifest.json'), out = projectPublicFilmManifest(source)
    expect(JSON.parse(out)).toEqual({ audio: 'Promotional films are not included in this public demo.', films: [] })
    expect(projectPublicFilmManifest(out)).toBe(out)
    expect(() => projectPublicFilmManifest(JSON.stringify({ ...JSON.parse(source), unknown: true }))).toThrow()
    expect(readPublicSource('public/campaign/films/manifest.json')).toBe(source)
  })

  it('checks the complete already-projected campaign before accepting it again', () => {
    const out = projectPublicCampaign(readPublicSource('campaign/index.html'))
    expect(() => projectPublicCampaign(out + '<video src="/campaign/films/private.mp4"></video>')).toThrow()
  })
  it('derives the generated Worker inventory from the empty manifest without changing serving logic or requesting films', async () => {
    const source = readPublicSource('worker/film-assets.ts'), manifest = readPublicSource('public/campaign/films/manifest.json')
    const out = projectPublicFilmAssets(source, manifest), empty = projectPublicFilmManifest(manifest)
    expect(out.slice(out.indexOf("import type { RateLimit }"))).toBe(source.slice(source.indexOf("import type { RateLimit }")))
    expect(projectPublicFilmAssets(source, manifest)).toBe(out)
    expect(projectPublicFilmAssets(out, empty)).toBe(out)
    expect(await inspectFilmAssets(out, empty)).toEqual({ inventory: [], requests: 0, answers: [null, null] })
    const changedRows = source.includes('import filmManifest') ? [source.replace('filmManifest.films', 'filmManifest.other'), source.replace('readonly { file:', 'readonly { unknown:')] :
      [source.replace("file: 'obpal-original", "file: 'unreviewed"), source.replace('bytes: 11054859', 'bytes: 1'),
        source.replace("file: 'obpal-original-complete-web.mp4'", "...{ file: 'obpal-original-complete-web.mp4' }")]
    for (const changed of [source.replace('const FILM_ASSETS', 'const UNKNOWN'), ...changedRows]) {
      expect(() => projectPublicFilmAssets(changed, manifest)).toThrow()
    }
    expect(readPublicSource('worker/film-assets.ts')).toBe(source)
  })
})
