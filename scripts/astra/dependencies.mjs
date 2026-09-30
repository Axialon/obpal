import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git, json, tree } from './common.mjs'

/** Reuse the coordinator's installed third-party packages without installation; workspace links point into the reviewed lane. */
export function reuseDependencies(root, lane, base, head) {
  if (existsSync(join(lane, 'node_modules'))) return
  const baseline = new Map(tree(root, base).map((e) => [e.path, e]))
  const approved = new Map(tree(lane, head).map((e) => [e.path, e]))
  const blob = (entries, path) => entries.has(path) ? git(root, ['cat-file', 'blob', entries.get(path).blob]).toString() : ''
  const lock = join(root, 'pnpm-lock.yaml')
  if (!existsSync(lock) || readFileSync(lock, 'utf8').replace(/\r\n/g, '\n') !== blob(baseline, 'pnpm-lock.yaml')) throw new Error('Cannot reuse dependencies: coordinator lockfile differs from stage base')
  const manifests = [...approved.keys()].filter((p) => /(?:^|\/)package\.json$/.test(p))
  const workspaces = new Map(manifests.map((p) => [JSON.parse(blob(approved, p)).name, dirname(p)]))
  const plans = []
  for (const path of manifests) {
    const old = JSON.parse(blob(baseline, path) || '{}'), next = JSON.parse(blob(approved, path))
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'pnpm']) {
      if (json(old[field] ?? {}) !== json(next[field] ?? {})) throw new Error(`Cannot reuse dependencies: ${path} changed ${field} without a changed lockfile; coordinator must reconcile the lockfile`)
    }
    const source = join(root, dirname(path), 'node_modules'), target = join(lane, dirname(path), 'node_modules')
    if (!existsSync(source)) {
      if (Object.keys(next.dependencies ?? {}).length || Object.keys(next.devDependencies ?? {}).length) throw new Error(`Coordinator dependencies unavailable for ${path}; prepare trusted dependencies before verification`)
      continue
    }
    plans.push({ source, target })
  }
  // Audit the complete plan before creating links, so a missing workspace does not leave a partly prepared tree.
  for (const { source, target } of plans) {
    mkdirSync(target, { recursive: true })
    const link = (from, to, name) => {
      if (workspaces.has(name)) from = join(lane, workspaces.get(name))
      const info = realpathSync(from)
      symlinkSync(info, to, 'junction')
    }
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name), to = join(target, entry.name)
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        mkdirSync(to)
        for (const child of readdirSync(from)) link(join(from, child), join(to, child), `${entry.name}/${child}`)
      } else if (entry.name === '.bin') {
        mkdirSync(to)
        for (const bin of readdirSync(from)) copyFileSync(join(from, bin), join(to, bin))
      } else if (entry.isDirectory() || entry.isSymbolicLink()) link(from, to, entry.name)
      else copyFileSync(from, to)
    }
  }
}
