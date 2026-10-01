import { readFileSync } from 'node:fs'

/** Read the catalogue asset without adding Node types to the browser configuration. */
export function readViewerModel(src) {
  if (!/^\/models\/(cvc|blackboxes)\/[a-zA-Z0-9_]+\.glb$/.test(src)) throw new Error('Invalid catalogue model path')
  const bytes = readFileSync(new URL(`../public${src}`, import.meta.url))
  return new Uint8Array(bytes).buffer
}
