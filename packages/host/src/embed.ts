/**
 * https://obpal.blackboxes.net/embed.js: ob.Pal for any page, as one script (PLAN §10 step 3). It defines
 * <obpal-remote> and window.obpal.remote(opts). Vite builds it as an ES module of its own (vite.config.ts, embedScript);
 * the SDK and the QR code load from beside it, relative to this script, only when they're needed.
 */
import { defineObpalRemote, ObpalRemote } from './element'
import type { Remote, RemoteOptions } from './remote'

declare const __OBPAL_VERSION__: string

/** The ob.Pal deployment this script came from: its room service is where the remotes it makes pair. */
const service = new URL(import.meta.url).origin

export interface ObpalGlobal {
  /** A Remote without the element (Remote.create), pairing through this script's service unless `opts.service` says otherwise. */
  remote(opts: RemoteOptions): Promise<Remote>
  /** The class behind <obpal-remote>. */
  Element: typeof ObpalRemote
  version: string
}

declare global {
  interface Window { obpal?: ObpalGlobal }
}

defineObpalRemote({ service })
if (typeof window !== 'undefined' && !window.obpal) {
  window.obpal = {
    async remote(opts) {
      // The element's own lazy part: one download for either way in.
      const { Remote } = await import('./element-host')
      return Remote.create({ service, ...opts })
    },
    Element: ObpalRemote,
    version: typeof __OBPAL_VERSION__ === 'string' ? __OBPAL_VERSION__ : 'dev',
  }
}

export { ObpalRemote }
export type { ObpalRemoteEventMap, ObpalRemoteStatus } from './element'
