/** Only these build-owned camera and simulation workers can pass the Trusted Types boundary. */
import qrURL from '../controller/qr-worker.ts?worker&url'
import handURL from '../controller/hand-worker.ts?worker&url'
import bodyURL from '../controller/body-worker.ts?worker&url'
import guardianURL from '../sim/humanoid/fake-guardian.worker.ts?worker&url'
import humanoidPhysicsURL from '../sim/humanoid/physics/world.worker.ts?worker&url'

const urls = { qr: qrURL, hand: handURL, body: bodyURL, guardian: guardianURL, humanoidPhysics: humanoidPhysicsURL }
let policy: { createScriptURL(s: string): unknown } | undefined
export function cameraWorker(kind: keyof typeof urls): Worker {
  const tt = (globalThis as typeof globalThis & { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(s: string): string }): typeof policy } }).trustedTypes
  if (tt) policy ??= tt.createPolicy('obpal-camera', { createScriptURL(s) {
    if (!Object.values(urls).includes(s)) throw new TypeError('Not a build-owned ob.Pal worker')
    return s
  } })
  return new Worker((policy?.createScriptURL(urls[kind]) ?? urls[kind]) as string)
}
