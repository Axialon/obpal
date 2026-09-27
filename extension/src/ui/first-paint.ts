/**
 * The look before the first paint: a classic script in the options page's <head>, built on its own (first-paint.js).
 * It runs before the page is drawn and puts the last look on <html> from its cache (./lookcache.ts), so a light or
 * other surface never shows the default one first. MV3 allows no inline script, and the page's module is deferred
 * (it may run after the first paint); ./look.ts takes over from there. The popup needs none: Chrome shows it only
 * once it has loaded, by when its module has put the look on.
 */
import { wearCachedLook } from './lookcache'

let storage: Storage | null = null
try {
  storage = localStorage
} catch {
  /* storage blocked: the default surface */
}
wearCachedLook(document.documentElement, document.cookie, storage)
