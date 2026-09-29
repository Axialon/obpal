/** Only the camera workers emitted by this build can pass the page's Trusted Types boundary. */
import qrURL from '../controller/qr-worker.ts?worker&url'
import handURL from '../controller/hand-worker.ts?worker&url'
import bodyURL from '../controller/body-worker.ts?worker&url'

const urls = { qr: qrURL, hand: handURL, body: bodyURL }
let policy: { createScriptURL(s: string): unknown } | undefined
export function cameraWorker(kind: keyof typeof urls): Worker {
  const tt = (globalThis as typeof globalThis & { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(s: string): string }): typeof policy } }).trustedTypes
  if (tt) policy ??= tt.createPolicy('obpal-camera', { createScriptURL(s) {
    if (!Object.values(urls).includes(s)) throw new TypeError('Not an ob.Pal camera worker')
    return s
  } })
  return new Worker((policy?.createScriptURL(urls[kind]) ?? urls[kind]) as string)
}
