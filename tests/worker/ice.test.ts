import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_STUN, forgetMinted, iceAnswer, MINT_REUSE_MS, parseUrls, relayOf, restCredentials, stunServers, TURN_TTL_S } from '../../worker/ice'
import { allow } from '../../worker/limits'

const NOW = 1_700_000_000_000
const quiet = { error: () => {}, warn: () => {} }

describe('ICE server URLs', () => {
  it('keeps well-formed URLs of the schemes asked for, and never port 53', () => {
    const urls = parseUrls(
      'turn:turn.example.org:3478?transport=udp, turns:turn.example.org:443?transport=tcp turn:[2001:db8::1]:3478 turn:x.example.org:53?transport=udp stun:s.example.org:3478 http://evil.example.org turn:bad_host! turn:t.example.org:99999',
      ['turn', 'turns'],
    )
    expect(urls).toEqual(['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:443?transport=tcp', 'turn:[2001:db8::1]:3478'])
  })

  it('uses STUN_URLS for STUN when given, else the default', () => {
    expect(stunServers({})).toEqual([{ urls: DEFAULT_STUN }])
    expect(stunServers({ STUN_URLS: 'stun:stun.example.org:3478,turn:no.example.org' })).toEqual([{ urls: ['stun:stun.example.org:3478'] }])
  })

  it('knows which relay is configured', () => {
    expect(relayOf({})).toBe(null)
    expect(relayOf({ TURN_KEY_ID: 'k' })).toBe(null)
    expect(relayOf({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' })).toBe('cloudflare')
    expect(relayOf({ TURN_URLS: 'turn:t.example.org', TURN_SECRET: 's' })).toBe('rest')
  })
})

describe('TURN REST API credentials (draft-uberti-behave-turn-rest)', () => {
  it('are <expiry>:obpal and base64(HMAC-SHA1(secret, username)), valid for a day', async () => {
    const c = await restCredentials('north-wind-secret', NOW)
    expect(c.username).toBe(`${NOW / 1000 + TURN_TTL_S}:obpal`)
    // Computed independently (Python's hmac): HMAC-SHA1("north-wind-secret", "1700086400:obpal").
    expect(c.credential).toBe('FJb4BERbc1QO3lux/W+uUJryZzo=')
    expect(c.expires).toBe(NOW + TURN_TTL_S * 1000)
  })
})

describe('/api/ice answers', () => {
  beforeEach(() => forgetMinted())

  it('STUN alone without a relay', async () => {
    expect(await iceAnswer({}, NOW)).toEqual({ iceServers: [{ urls: DEFAULT_STUN }], turn: false })
  })

  it('a standard TURN server: its URLs with fresh credentials, and when they lapse', async () => {
    const a = await iceAnswer({ TURN_URLS: 'turn:t.example.org:3478?transport=udp,turns:t.example.org:443?transport=tcp', TURN_SECRET: 'north-wind-secret' }, NOW)
    expect(a.turn).toBe(true)
    expect(a.expires).toBe(NOW + TURN_TTL_S * 1000)
    expect(a.iceServers[0]).toEqual({ urls: DEFAULT_STUN })
    expect(a.iceServers[1]).toEqual({ urls: ['turn:t.example.org:3478?transport=udp', 'turns:t.example.org:443?transport=tcp'], username: '1700086400:obpal', credential: 'FJb4BERbc1QO3lux/W+uUJryZzo=' })
  })

  it('Cloudflare TURN: asks its API for a day, drops port 53 and repeated STUN, and reuses the set for a few minutes', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Response.json({
        iceServers: {
          urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
          username: 'u', credential: 'c',
        },
      })
    }
    const env = { TURN_KEY_ID: 'key-id', TURN_KEY_API_TOKEN: 'token' }
    const a = await iceAnswer(env, NOW, fetcher, quiet)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer token')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ ttl: TURN_TTL_S })
    expect(a).toEqual({
      iceServers: [{ urls: DEFAULT_STUN }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }],
      turn: true, expires: NOW + TURN_TTL_S * 1000,
    })
    await iceAnswer(env, NOW + MINT_REUSE_MS - 1, fetcher, quiet)
    expect(calls).toHaveLength(1)
    await iceAnswer(env, NOW + MINT_REUSE_MS + 1, fetcher, quiet)
    expect(calls).toHaveLength(2)
  })

  it('falls back to STUN when the relay fails, and logs only what went wrong', async () => {
    const logged: string[] = []
    const a = await iceAnswer({ TURN_KEY_ID: 'key-id', TURN_KEY_API_TOKEN: 'token' }, NOW, async () => new Response('no', { status: 503 }), { error: (m: string) => logged.push(m) })
    expect(a).toEqual({ iceServers: [{ urls: DEFAULT_STUN }], turn: false })
    expect(logged).toEqual(['obpal ice: no TURN credentials (cloudflare): Cloudflare TURN answered 503'])
  })
})

describe('rate limits', () => {
  it('fail open: no binding lets everything through (said once), a binding that throws too', async () => {
    const warned: string[] = []
    const log = { warn: (m: string) => warned.push(m) }
    expect(await allow(undefined, 'a', log)).toBe(true)
    expect(await allow(undefined, 'a', log)).toBe(true)
    expect(warned).toHaveLength(1)
    expect(await allow({ limit: async () => { throw new Error('down') } }, 'a', log)).toBe(true)
  })

  it('refuse what the binding refuses, by key', async () => {
    const seen: string[] = []
    const rl = { limit: async ({ key }: { key: string }) => { seen.push(key); return { success: key !== 'busy' } } }
    expect(await allow(rl, 'calm')).toBe(true)
    expect(await allow(rl, 'busy')).toBe(false)
    expect(seen).toEqual(['calm', 'busy'])
  })
})
