/**
 * ob.Pal themes are the Blackboxes family surfaces (src/family). The theme only picks what the UI sits on;
 * ob.Pal's identity accent stays lime on every surface. UI colours come from the family CSS tokens, while
 * the 3D stage colours (backdrop gradient and ground grid) live here because three.js needs them as values.
 */
import { family, type FamilyThemeId } from '../family'

export interface Theme {
  id: FamilyThemeId
  name: string
  /** Page background. */
  base: string
  /** Glass tint for resting surfaces. */
  surface: string
  /** Identity accent (ob.Pal lime). */
  accent: string
  /** Light surface: dark ink, calmer bloom. */
  light: boolean
  /** 3D stage backdrop, centre to edge. */
  scene: [string, string, string]
  grid: string
}

const ACCENT = '#C6FF34'
const STAGE: Record<FamilyThemeId, { scene: [string, string, string]; grid: string }> = {
  carbon: { scene: ['#262626', '#121212', '#050505'], grid: '#8fb04a' },
  navy: { scene: ['#17283f', '#0a1424', '#03070e'], grid: '#6f8fbf' },
  violet: { scene: ['#2b1f4b', '#140d27', '#07040e'], grid: '#8b7bc9' },
  wine: { scene: ['#3a2e35', '#1b1418', '#090607'], grid: '#b09aa6' },
  onyx: { scene: ['#151c22', '#08090b', '#020202'], grid: '#7a99aa' },
  light: { scene: ['#ffffff', '#edf1f6', '#dce3ec'], grid: '#8a9ab0' },
}

export const THEMES: Theme[] = family.THEMES.map((t) => ({
  id: t.id, name: t.name, base: t.page, surface: t.surface, accent: ACCENT, light: t.light, ...STAGE[t.id],
}))

export const DEFAULT_THEME: FamilyThemeId = family.DEFAULT_THEME
/** Earlier ob.Pal themes paired an accent with a surface; map them onto the nearest family surface. */
const LEGACY: Record<string, FamilyThemeId> = { lime: 'carbon', lavender: 'violet', turquoise: 'wine', candy: 'onyx' }

export const themeById = (id: string | null | undefined): Theme => {
  const key = (id && LEGACY[id]) || id
  return THEMES.find((t) => t.id === key) ?? THEMES.find((t) => t.id === family.getTheme()) ?? THEMES[0]
}

/** The surface to start with: the ecosystem-wide choice, else a pre-family ob.Pal choice, else the default. */
export function initialTheme(): Theme {
  let chosen = /(?:^|;\s*)bb_theme=/.test(document.cookie)
  try { chosen ||= !!localStorage.getItem('bb_theme') } catch { /* private mode */ }
  if (chosen) return themeById(family.getTheme())
  let legacy: string | null = null
  try { legacy = localStorage.getItem('obpal.theme2') } catch { /* private mode */ }
  // A pre-family theme was an accent on a surface: keep both, so the look carries over exactly.
  const accent = legacy && LEGACY_ACCENT[legacy]
  if (accent && family.getAccent() === 'product') family.setAccent(accent)
  return themeById(legacy)
}
const LEGACY_ACCENT: Record<string, string> = { lavender: 'lavender', turquoise: 'turquoise', candy: 'candy' }

/** Apply a surface: family tokens switch through data-bb-theme, and the choice is remembered across *.blackboxes.net. */
export function applyTheme(t: Theme) {
  family.setProduct('obpal')
  family.setTheme(t.id)
  document.documentElement.dataset.theme = t.id
}

/** Two-tone swatch markup for theme pickers: the surface with ob.Pal's accent. */
export const swatch = (t: Theme) =>
  `<span class="swatch" style="--sw-a:${t.surface};--sw-b:${t.accent}" aria-hidden="true"><i></i><i></i></span>`
