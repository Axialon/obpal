/**
 * Brakes on abuse of the room service: how many room sockets and ICE lookups (TURN credentials) one address may start
 * a minute, through the Workers rate-limit bindings (wrangler.jsonc "ratelimits"). They count per Cloudflare location
 * and settle eventually, so they are a brake rather than a quota, set well above what people need.
 */

/** A Workers rate-limit binding. */
export interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }

let warned = false

/**
 * Whether `key` may go ahead under `rl`. Without the binding (a self-hosted service that leaves it out), or when it
 * fails, everything may: a limit must never turn into an outage. A missing binding is said once per isolate.
 */
export async function allow(rl: RateLimit | undefined, key: string, log: Pick<Console, 'warn'> = console): Promise<boolean> {
  if (!rl) {
    if (!warned) { warned = true; log.warn('obpal limits: no rate-limit binding; room sockets and ICE lookups are not limited') }
    return true
  }
  try {
    return (await rl.limit({ key })).success
  } catch {
    return true
  }
}
