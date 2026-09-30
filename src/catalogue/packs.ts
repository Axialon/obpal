/** Read and cache the published pack catalogue; a cached envelope is checked again before use. */
import { checkPack, packProfileId, PACK_LIMITS, PACK_VERSION, type Pack } from '@obpal/core'
import { HUMANOID } from '../sim/humanoid/profile'

const KEY = 'obpal.packs.v1'
const MAX_CATALOGUE = PACK_LIMITS.catalogueBytes
const context = { rigs: { [HUMANOID.id]: Object.fromEntries(HUMANOID.joints.map((j) => [j.id, j.limits])) } }
let current: Pack[] = []
let pending: Promise<Pack[]> | undefined
export const communityPacks = () => current

export function readPackCatalogue(text: string): Pack[] {
  if (new TextEncoder().encode(text).length > MAX_CATALOGUE) throw new Error('Pack catalogue too large')
  const data = JSON.parse(text) as { version?: unknown; community?: unknown }
  if (data?.version !== PACK_VERSION || !Array.isArray(data.community) || data.community.length > PACK_LIMITS.packs) throw new Error('Unsupported pack catalogue')
  const packs = data.community.map((x: unknown) => {
    const { pack, errors } = checkPack(x, context)
    if (!pack) throw new Error(errors.join('; '))
    return pack
  })
  if (new Set(packs.map((p) => p.id)).size !== packs.length) throw new Error('Duplicate pack id')
  const profiles = packs.filter((p): p is Pack<'profile'> => p.kind === 'profile')
  if (new Set(profiles.map(packProfileId)).size !== profiles.length) throw new Error('Duplicate profile wire alias')
  return packs
}

/** Cached data is usable before the network refresh finishes, including when offline. */
export function cachedPacks(): Pack[] {
  try { current = readPackCatalogue(localStorage.getItem(KEY) ?? '') } catch { /* empty or obsolete cache */ }
  return current
}

export function loadCommunityPacks(): Promise<Pack[]> {
  if (pending) return pending
  cachedPacks()
  pending = (async () => {
    try {
      const response = await fetch('/catalogue.json', { signal: AbortSignal.timeout(8000), cache: 'no-cache' })
      if (!response.ok || !response.body) throw new Error('Pack catalogue unavailable')
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let text = '', bytes = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_CATALOGUE) { await reader.cancel(); throw new Error('Pack catalogue too large') }
        text += decoder.decode(chunk.value, { stream: true })
      }
      text += decoder.decode()
      current = readPackCatalogue(text)
      try { localStorage.setItem(KEY, JSON.stringify({ version: PACK_VERSION, community: current })) } catch { /* private mode or quota */ }
    } catch { /* keep the last checked catalogue for offline use */ }
    return current
  })().finally(() => { pending = undefined })
  return pending
}
