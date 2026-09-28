/** Read a committed model for the geometry contract tests without exposing Node types to site code. */
import { readFileSync } from 'node:fs'
export function readModel(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid model name')
  return new Uint8Array(readFileSync(new URL(`../../public/models/${name}.glb`, import.meta.url))).buffer
}
