/** The phone's pack library. Selection keys stay namespaced; the existing mode packet uses a bounded alias. */
import { isProfileId, PACK_ID, packCredit, packProfileId, PROFILES, type Pack, type ProfileSpec } from '@obpal/core'
import { communityPacks, loadCommunityPacks } from '../catalogue/packs'
import { dotLoading } from '../ui/kit/loading'

const ARRIVAL = 'obpal.pack-arrival'
let requested: string | null = null
if (typeof location !== 'undefined') {
  const query = new URLSearchParams(location.search).get('pack')
  try {
    if (query && PACK_ID.test(query)) sessionStorage.setItem(ARRIVAL, query)
    requested = query && PACK_ID.test(query) ? query : sessionStorage.getItem(ARRIVAL)
  } catch { requested = query && PACK_ID.test(query) ? query : null }
}
export const requestedPhonePack = () => requested
export function clearPackArrival() {
  requested = null
  try { sessionStorage.removeItem(ARRIVAL) } catch { /* private mode */ }
  if (typeof location === 'undefined') return
  const url = new URL(location.href)
  url.searchParams.delete('pack')
  history.replaceState(history.state, '', url)
}
/** Explain a catalogue handoff while the phone waits for a screen's pairing code. */
export function showPackArrival() {
  if (!requested) return
  const pending = document.getElementById('pack-arrival')
  if (pending) { pending.hidden = false; dotLoading(pending, true, 'Opening the selected pack') }
  void loadCommunityPacks().then(() => {
    const node = document.getElementById('pack-arrival')
    if (!node) return
    dotLoading(node, false)
    const pack = communityPacks().find((p) => p.id === requested && !p.deprecated)
    node.hidden = false
    node.textContent = pack ? `${pack.name} · ${packCredit(pack)} · ${pack.attribution}. Connect to a screen, then open Profile to use this pack.` : 'This pack is unavailable. Connect to the internet and check the community catalogue.'
  })
}

export const phoneProfiles = () => communityPacks().filter((p): p is Pack<'profile'> => p.kind === 'profile' && !p.deprecated && ['face.gamepad', 'face.wheel'].includes(p.body.controller ?? 'face.gamepad'))
export const phoneProfilePack = (id: string) => phoneProfiles().find((p) => p.id === id || packProfileId(p) === id)
export const phoneProfile = (id: string): ProfileSpec | undefined => isProfileId(id) ? PROFILES[id] : phoneProfilePack(id)?.body
const mappings = new Map<string, string>()
export function phoneMapping(host = ''): Pack<'mapping'> | undefined {
  let selectedMapping = mappings.get(host) ?? ''
  try { selectedMapping = localStorage.getItem(`obpal.pack-mapping.${host}`) ?? selectedMapping } catch { /* private mode */ }
  return communityPacks().find((p): p is Pack<'mapping'> => p.kind === 'mapping' && !p.deprecated && p.id === selectedMapping)
}
export function selectPhoneMapping(id: string, host = '') {
  mappings.set(host, id)
  try { id ? localStorage.setItem(`obpal.pack-mapping.${host}`, id) : localStorage.removeItem(`obpal.pack-mapping.${host}`) } catch { /* private mode */ }
}
