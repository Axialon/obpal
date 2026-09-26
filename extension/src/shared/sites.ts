/**
 * Which catalogue profile to suggest for a site (CATALOGUE §3): a data table, matched on the host of any bridged
 * frame in the controlled tab (a game usually lives in a frame from another domain). The phone applies the suggestion
 * unless its user chose a profile for this host before.
 */
import type { ProfileId } from '@obpal/core'

export interface SiteProfile {
  /** A host name; it also matches its subdomains. */
  host: string
  profile: ProfileId
}

export const SITE_PROFILES: readonly SiteProfile[] = [
  // CVC Collider (Godot flight game): turning and looking sit on the right stick, so tilt the phone like a yoke.
  { host: 'tesana.com', profile: 'flight' },
  { host: 'play.tesana.ai', profile: 'flight' },
  // Browser first-person shooters with pointer lock: gyro mouse.
  { host: 'krunker.io', profile: 'shooter' },
  { host: 'venge.io', profile: 'shooter' },
  { host: 'shellshock.io', profile: 'shooter' },
  { host: 'voxiom.io', profile: 'shooter' },
]

/** The profile suggested for a host name, or null when the table has nothing for it. */
export function suggestProfile(hostname: string, table: readonly SiteProfile[] = SITE_PROFILES): ProfileId | null {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h) return null
  for (const s of table) if (h === s.host || h.endsWith(`.${s.host}`)) return s.profile
  return null
}

/** One suggestion for a tab from the hosts of its frames: the top frame first, then any frame that matches. */
export function suggestForFrames(hosts: readonly { frameId: number; host: string }[], table: readonly SiteProfile[] = SITE_PROFILES): ProfileId | null {
  const sorted = [...hosts].sort((a, b) => a.frameId - b.frameId)
  for (const f of sorted) {
    const p = suggestProfile(f.host, table)
    if (p) return p
  }
  return null
}
