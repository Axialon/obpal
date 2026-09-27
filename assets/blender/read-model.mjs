/** Read a committed model for the geometry contract tests without exposing Node types to site code. */
import { readFileSync } from 'node:fs'
export function readModel(name) {
  if (!['drone', 'so101', 'rover'].includes(name)) throw new Error('Unknown prototype')
  return new Uint8Array(readFileSync(new URL(`../../public/models/${name}.glb`, import.meta.url))).buffer
}
