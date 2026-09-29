/**
 * Keeping the last builds' hashed files across a deploy (scripts/keep-assets.mjs). A build names each chunk and
 * stylesheet by its content, and a deploy replaces the site's files with the new build's alone, so a page opened
 * before the deploy (or its HTML, still on an edge cache just after) asks for chunks that no longer exist. Each
 * deploy carries the last KEEP_BUILDS builds' files along instead, so a page from a build that old still finds its
 * chunks. A name never holds two different files, so nothing collides and the new build's own files win.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** How many deployed builds' files are kept, and carried into the next deploys. */
export const KEEP_BUILDS = 2
/** Where they are kept, in the repository (ignored by git). */
export const STORE = '.kept-assets'

/**
 * The folder `wrangler deploy` uploads as the site's files: the one the build's redirected config names (`vite build`
 * writes .wrangler/deploy/config.json, and wrangler follows it).
 * @param {string} root the repository
 */
export function deployedSite(root) {
  const redirect = join(root, '.wrangler', 'deploy', 'config.json')
  if (!existsSync(redirect)) throw new Error('there is no build to deploy: run `pnpm run build` first')
  const config = resolve(dirname(redirect), JSON.parse(readFileSync(redirect, 'utf8')).configPath)
  const directory = JSON.parse(readFileSync(config, 'utf8')).assets?.directory
  if (!directory) throw new Error(`${config} names no assets directory`)
  return resolve(dirname(config), directory)
}

/**
 * Every file under `dir`, as '/'-separated paths relative to it (none when it isn't there).
 * @param {string} dir
 * @returns {string[]}
 */
export function listFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath ?? e.path, e.name)).replaceAll('\\', '/'))
    .sort()
}

/**
 * The kept builds, newest first: folders of the store named by a counter that only grows.
 * @param {string} store
 * @returns {string[]}
 */
export function keptBuilds(store) {
  if (!existsSync(store)) return []
  return readdirSync(store, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(b) - Number(a))
}

/**
 * Copies the kept builds' files that the new build lacks into its assets folder, and reads what the new build itself
 * holds before that. Run after `vite build` and before `wrangler deploy`.
 * @param {{ site: string; store: string; keep?: number }} o site: the folder wrangler deploys
 * @returns {{ fresh: string[]; carried: string[]; from: string[] }} the new build's files, the files added, the builds they came from
 */
export function carryKept({ site, store, keep = KEEP_BUILDS }) {
  const assets = join(site, 'assets')
  const fresh = listFiles(assets)
  if (!fresh.length) throw new Error(`${assets} holds no build: run \`pnpm run build\` first`)
  const from = keptBuilds(store).slice(0, keep)
  const carried = []
  for (const build of from) {
    const source = join(store, build, 'assets')
    for (const file of listFiles(source)) {
      const to = join(assets, file)
      if (existsSync(to)) continue
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(join(source, file), to)
      carried.push(file)
    }
  }
  return { fresh, carried, from }
}

/**
 * Keeps a deployed build's own files as the newest of the kept builds, and drops the oldest beyond `keep`. The same
 * build deployed again (its files unchanged) is kept once. Returns the folder it made, or null when it was already there.
 * @param {{ site: string; store: string; fresh: string[]; keep?: number }} o fresh: the files carryKept found in the build
 * @returns {string | null}
 */
export function keepBuild({ site, store, fresh, keep = KEEP_BUILDS }) {
  const builds = keptBuilds(store)
  const same = (build) => {
    const kept = listFiles(join(store, build, 'assets'))
    return kept.length === fresh.length && kept.every((f, i) => f === fresh[i])
  }
  let made = null
  if (!builds.length || !same(builds[0])) {
    made = join(store, String((builds.length ? Number(builds[0]) : 0) + 1).padStart(6, '0'))
    for (const file of fresh) {
      const to = join(made, 'assets', file)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(join(site, 'assets', file), to)
    }
  }
  for (const build of keptBuilds(store).slice(keep)) rmSync(join(store, build), { recursive: true, force: true })
  return made
}
