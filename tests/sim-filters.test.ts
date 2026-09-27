import { expect, it } from 'vitest'
import { CATEGORIES, filterSims, filtersFrom, filtersUrl, SIMS } from '../src/sim/catalogue'

it('gives every card one category and keeps collections separate', () => {
  for (const card of SIMS) expect(CATEGORIES.some(c => c.id === card.category)).toBe(true)
  expect(filterSims(SIMS, { category: 'featured', face: null, q: '' }).length).toBeGreaterThan(0)
  expect(filterSims(SIMS, { category: 'robotics', face: null, q: '' }).map(c => c.id)).toContain('arm-scara')
})

it('intersects category, controller and all search terms, including what the controller does', () => {
  expect(filterSims(SIMS, { category: 'vehicles', face: 'face.wheel', q: 'harbour rudder' }).map(c => c.id)).toEqual(['boat'])
  expect(filterSims(SIMS, { category: 'home', face: 'face.wheel', q: '' })).toEqual([])
  expect(filterSims(SIMS, { category: null, face: null, q: '  wii  camera ' }).map(c => c.id)).toContain('ptz')
})

it('finds the studio in Music, Featured and New through both music controllers and search', () => {
  expect(SIMS.find(c => c.id === 'studio')).toMatchObject({ category: 'music', featured: true, fresh: true, controllers: ['face.drums', 'face.keys'] })
  expect(filterSims(SIMS, { category: null, face: null, q: 'drums' }).map(c => c.id)).toEqual(['studio'])
  for (const category of ['music', 'featured', 'new'] as const) {
    for (const face of ['drums', 'keys']) {
      const filters = filtersFrom(`?category=${category}&face=${face}&q=drums`)
      expect(filterSims(SIMS, filters).map(c => c.id)).toEqual(['studio'])
    }
  }
})

it('reads old controller links and canonicalises safe filter URLs without losing other parameters', () => {
  expect(filtersFrom('?face=face.wii&category=home&q=warm')).toEqual({ face: 'face.wii', category: 'home', q: 'warm' })
  expect(filtersFrom('?face=unknown&category=unknown')).toEqual({ face: null, category: null, q: '' })
  const url = filtersUrl(new URL('https://example.test/sim/?keep=yes#cards'), { face: 'face.wii', category: 'camera-stage', q: 'pan tilt' })
  expect(url.searchParams.get('face')).toBe('wii')
  expect(url.searchParams.get('q')).toBe('pan tilt')
  expect(url.searchParams.get('category')).toBe('camera-stage')
  expect(url.searchParams.get('keep')).toBe('yes')
  expect(url.hash).toBe('#cards')
  expect(filtersUrl(url, { face: null, category: null, q: '' }).search).toBe('?keep=yes')
})
