/** Editable stage lighting: presets plus fine controls, applied live and remembered per device. */
export interface Lighting {
  exposure: number
  env: number
  key: number
  rim: number
  glow: number
  threshold: number
  radius: number
  backdrop: number
  grid: number
  shadow: number
}

export const LIGHT_PRESETS: { id: string; name: string; values: Lighting }[] = [
  { id: 'studio', name: 'Studio', values: { exposure: 0.82, env: 0.55, key: 1.35, rim: 1.5, glow: 0.22, threshold: 0.9, radius: 0.4, backdrop: 1, grid: 1, shadow: 1 } },
  { id: 'soft', name: 'Soft', values: { exposure: 0.9, env: 0.9, key: 0.8, rim: 0.6, glow: 0.12, threshold: 0.93, radius: 0.5, backdrop: 1.1, grid: 0.7, shadow: 0.7 } },
  { id: 'dramatic', name: 'Dramatic', values: { exposure: 0.74, env: 0.22, key: 2.3, rim: 2.4, glow: 0.3, threshold: 0.86, radius: 0.35, backdrop: 0.65, grid: 0.55, shadow: 1.25 } },
  { id: 'neon', name: 'Neon', values: { exposure: 0.8, env: 0.32, key: 0.9, rim: 2.8, glow: 0.8, threshold: 0.68, radius: 0.72, backdrop: 0.6, grid: 1.25, shadow: 0.8 } },
  { id: 'showroom', name: 'Showroom', values: { exposure: 1, env: 1.05, key: 1.6, rim: 1, glow: 0.16, threshold: 0.93, radius: 0.4, backdrop: 1.3, grid: 0.45, shadow: 0.9 } },
]

export const LIGHT_CONTROLS: { key: keyof Lighting; label: string; min: number; max: number; step: number }[] = [
  { key: 'exposure', label: 'Exposure', min: 0.4, max: 1.6, step: 0.01 },
  { key: 'env', label: 'Ambient', min: 0, max: 1.6, step: 0.01 },
  { key: 'key', label: 'Key light', min: 0, max: 3.5, step: 0.05 },
  { key: 'rim', label: 'Rim light', min: 0, max: 3.5, step: 0.05 },
  { key: 'glow', label: 'Glow', min: 0, max: 1.5, step: 0.01 },
  { key: 'threshold', label: 'Glow threshold', min: 0.4, max: 1, step: 0.01 },
  { key: 'radius', label: 'Glow spread', min: 0, max: 1, step: 0.01 },
  { key: 'backdrop', label: 'Backdrop', min: 0.2, max: 1.6, step: 0.01 },
  { key: 'grid', label: 'Grid', min: 0, max: 1.6, step: 0.01 },
  { key: 'shadow', label: 'Shadow', min: 0, max: 1.6, step: 0.01 },
]

const KEY = 'obpal.lighting'

export function loadLighting(): { preset: string; values: Lighting } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (raw?.values) return { preset: String(raw.preset ?? 'custom'), values: { ...LIGHT_PRESETS[0].values, ...raw.values } }
  } catch { /* fall back */ }
  return { preset: 'studio', values: { ...LIGHT_PRESETS[0].values } }
}

export function saveLighting(preset: string, values: Lighting) {
  try { localStorage.setItem(KEY, JSON.stringify({ preset, values })) } catch { /* private mode */ }
}
