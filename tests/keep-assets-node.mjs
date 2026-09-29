/**
 * Node-side helpers for tests/keep-assets.test.ts, which is type-checked without Node's types: throwaway folders that
 * hold a built site (its hashed assets and a page), and a build's redirected wrangler config.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const joinPath = join

const made = []

/** A new empty folder, removed by removeTemp(). */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'obpal-kept-'))
  made.push(dir)
  return dir
}

export function removeTemp() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** The built site under `root`, made afresh: each asset holds the text given, and there is a page that isn't an asset. Returns its folder. */
export function writeSite(root, files) {
  const site = join(root, 'site')
  rmSync(site, { recursive: true, force: true })
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(site, 'assets', name)), { recursive: true })
    writeFileSync(join(site, 'assets', name), body)
  }
  writeFileSync(join(site, 'index.html'), '<!doctype html>')
  return site
}

export const readAsset = (site, name) => readFileSync(join(site, 'assets', name), 'utf8')

/** What `vite build` writes for wrangler: .wrangler/deploy/config.json naming dist/worker/wrangler.json, whose assets are ../client. */
export function writeRedirect(root) {
  mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true })
  mkdirSync(join(root, 'dist', 'worker'), { recursive: true })
  writeFileSync(join(root, '.wrangler', 'deploy', 'config.json'), JSON.stringify({ configPath: join('..', '..', 'dist', 'worker', 'wrangler.json') }))
  writeFileSync(join(root, 'dist', 'worker', 'wrangler.json'), JSON.stringify({ assets: { directory: '../client' } }))
}
