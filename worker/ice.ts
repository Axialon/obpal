/**
 * ICE servers for a room (PROTOCOL §1): STUN, plus short-lived TURN credentials from whichever relay the service has.
 * ICE tries the direct paths first (the same network, then through NAT with STUN) and uses a relay only when neither
 * works; a relay can't read what it carries, since WebRTC encrypts end to end (DTLS) whatever path the packets take.
 *
 *  - Cloudflare Realtime TURN: the secrets TURN_KEY_ID and TURN_KEY_API_TOKEN. Credentials come from its API.
 *  - Any standard TURN server (coturn, eturnal, …): TURN_URLS (a var: turn: and turns: URLs, comma-separated) and the
 *    secret TURN_SECRET, which the server shares. Credentials follow the TURN REST API's shared-secret scheme
 *    (draft-uberti-behave-turn-rest; coturn's use-auth-secret, eturnal's secret): the username is
 *    `<expiry, unix seconds>:obpal` and the password base64(HMAC-SHA1(TURN_SECRET, username)).
 *  - STUN_URLS (a var: stun: URLs, comma-separated) replaces the default STUN server.
 *
 * Credentials last TURN_TTL_S (a day, as the TURN REST API suggests), and the answer says when they lapse (`expires`,
 * epoch ms), so a host that stays open longer fetches fresh ones before then: a relay drops an allocation whose
 * credentials have run out. Credentials aren't tied to a person or a room, so one set serves every lookup for a few
 * minutes (MINT_REUSE_MS) instead of asking the relay's API each time.
 *
 * Plain logic (the Worker passes its env and fetch), so it can be tested without the Workers runtime.
 */

export interface IceEnv {
  TURN_KEY_ID?: string
  TURN_KEY_API_TOKEN?: string
  TURN_URLS?: string
  TURN_SECRET?: string
  STUN_URLS?: string
}

export interface IceServer { urls: string[]; username?: string; credential?: string }

/** What GET /api/ice answers. `expires`: when the TURN credentials lapse (epoch ms), with `turn` only. */
export interface IceAnswer { iceServers: IceServer[]; turn: boolean; expires?: number }

/** How long TURN credentials last: a day, as draft-uberti-behave-turn-rest suggests. */
export const TURN_TTL_S = 86_400
/** One set of minted credentials serves lookups for this long. */
export const MINT_REUSE_MS = 5 * 60_000
export const DEFAULT_STUN = ['stun:stun.cloudflare.com:3478']
const CLOUDFLARE_API = 'https://rtc.live.cloudflare.com/v1/turn/keys'

/**
 * URLs from a comma- or space-separated list: those of the given schemes, well formed, and not on port 53 (browsers
 * refuse it, and a server they can't reach only slows ICE down).
 */
export function parseUrls(list: string | undefined, schemes: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of (list ?? '').split(/[\s,]+/)) {
    const u = raw.trim()
    const m = /^([a-z]+):([A-Za-z0-9.\-[\]:]+?)(?::(\d{1,5}))?(\?transport=(udp|tcp))?$/.exec(u)
    const port = m?.[3] ? Number(m[3]) : 0
    if (!m || !schemes.includes(m[1]) || port === 53 || port > 65535 || out.includes(u)) continue
    out.push(u)
  }
  return out
}

/** Leave out URLs on port 53 (Cloudflare lists one; browsers never reach it). */
const reachable = (urls: string[]) => urls.filter((u) => !/:53(\?|$)/.test(u))

export function stunServers(env: IceEnv): IceServer[] {
  const urls = parseUrls(env.STUN_URLS, ['stun'])
  return [{ urls: urls.length ? urls : DEFAULT_STUN }]
}

/** TURN REST API credentials for a server that shares `secret`, valid for `ttlS` from `now` (epoch ms). */
export async function restCredentials(secret: string, now: number, ttlS = TURN_TTL_S): Promise<{ username: string; credential: string; expires: number }> {
  const expiry = Math.floor(now / 1000) + ttlS
  const username = `${expiry}:obpal`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username)))
  let bin = ''
  for (const b of mac) bin += String.fromCharCode(b)
  return { username, credential: btoa(bin), expires: expiry * 1000 }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Cloudflare TURN credentials from its API (null when it says no). */
async function cloudflareTurn(env: IceEnv, fetcher: Fetch, now: number): Promise<{ servers: IceServer[]; expires: number } | null> {
  const r = await fetcher(`${CLOUDFLARE_API}/${encodeURIComponent(env.TURN_KEY_ID!)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: TURN_TTL_S }),
  })
  if (!r.ok) throw new Error(`Cloudflare TURN answered ${r.status}`)
  const j = (await r.json()) as { iceServers?: { urls: string | string[]; username?: string; credential?: string } | { urls: string | string[]; username?: string; credential?: string }[] }
  const list = Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : []
  const servers = list
    .map((s) => ({ urls: reachable(Array.isArray(s.urls) ? s.urls : [s.urls]), ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) }))
    .filter((s) => s.urls.length)
  return servers.some((s) => s.username && s.credential) ? { servers, expires: now + TURN_TTL_S * 1000 } : null
}

/** A standard TURN server's credentials, made here from the shared secret. */
async function restTurn(env: IceEnv, now: number): Promise<{ servers: IceServer[]; expires: number } | null> {
  const urls = parseUrls(env.TURN_URLS, ['turn', 'turns'])
  if (!urls.length) return null
  const c = await restCredentials(env.TURN_SECRET!, now)
  return { servers: [{ urls, username: c.username, credential: c.credential }], expires: c.expires }
}

/** Which relay this service has: Cloudflare's, a standard TURN server of its own, or none. */
export function relayOf(env: IceEnv): 'cloudflare' | 'rest' | null {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) return 'cloudflare'
  if (env.TURN_URLS && env.TURN_SECRET) return 'rest'
  return null
}

let minted: { at: number; servers: IceServer[]; expires: number } | null = null

/** Forget the credentials this isolate keeps (for tests). */
export function forgetMinted() { minted = null }

/**
 * The ICE servers to hand out: STUN, and TURN from the configured relay (credentials reused for MINT_REUSE_MS while
 * they have most of their day left). A relay that can't be reached leaves STUN alone, never an error: ICE still tries
 * every direct path.
 */
export async function iceAnswer(env: IceEnv, now = Date.now(), fetcher: Fetch = fetch, log: Pick<Console, 'error'> = console): Promise<IceAnswer> {
  const stun = stunServers(env)
  const relay = relayOf(env)
  if (!relay) return { iceServers: stun, turn: false }
  if (!minted || now - minted.at > MINT_REUSE_MS || minted.expires - now < (TURN_TTL_S * 1000) / 2) {
    try {
      const got = relay === 'cloudflare' ? await cloudflareTurn(env, fetcher, now) : await restTurn(env, now)
      minted = got ? { at: now, ...got } : null
    } catch (e) {
      // Only what went wrong: no room, no address, no credentials.
      log.error(`obpal ice: no TURN credentials (${relay}): ${e instanceof Error ? e.message : 'failed'}`)
      minted = null
    }
  }
  if (!minted) return { iceServers: stun, turn: false }
  // The relay's own STUN URLs (Cloudflare lists them beside TURN) aren't repeated.
  const have = new Set(stun.flatMap((s) => s.urls))
  const relays = minted.servers.map((s) => ({ ...s, urls: s.urls.filter((u) => !have.has(u)) })).filter((s) => s.urls.length)
  return { iceServers: [...stun, ...relays], turn: true, expires: minted.expires }
}
