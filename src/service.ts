/** Site-owned screens pair through their own service. This keeps the SDK's third-party hosted default intact. */
import type { RemoteOptions } from '@obpal/host'

export function siteOptions(options: RemoteOptions, origin = location.origin): RemoteOptions {
  return { service: origin, ...options }
}
