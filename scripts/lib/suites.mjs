/** Page ownership plus actual transitive script imports select validation for changed paths. */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { knownSuites } from './e2e.mjs'

export const PATH_SUITES = [
  [/^(?:packages\/core(?:\/|$)|src\/ui\/kit(?:[./]|$)|src\/styles(?:[./]|$)|worker\/)/, '*'],
  [/^packages\/host\//, ['home', 'pages', 'embed', 'code', 'shared', 'extension', 'phone', 'sims', 'camera', 'contact', 'catalogue']],
  [/^src\/(?:controller\/(?:scanner|scan)|ui\/(?:camera|scan))|(?:^|\/)scan[^/]*\.(?:ts|js|css)$/, ['camera', 'phone']],
  [/^src\/sim\/audio\//, ['sims']],
  [/^src\/sim\//, ['sims', 'contact', 'catalogue', 'shared']],
  [/^src\/landing\//, ['home', 'pages']],
  [/^src\/(?:controller|camera)\//, ['phone', 'camera', 'orientation', 'catalogue', 'sims']],
  [/^src\/view\//, ['camera', 'pages', 'shared', 'sims']],
  [/^extension\//, ['extension']],
  [/^src\/(?:pages|support)\//, ['pages', 'code']],
  [/^(?:public\/|src\/family\/|src\/shared\/|src\/ui\/|src\/main\.|index\.html|vite\.config|package\.json|pnpm-lock)/, '*'],
]

/** Discover script dependencies, including dynamically imported helper modules. */
export function suiteGraph(root) {
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts
  const graph = new Map()
  for (const suite of knownSuites(scripts)) {
    const start = suite === 'extension' ? 'extension/scripts/e2e.mjs' : /node\s+([^\s]+\.mjs)/.exec(scripts[`e2e:${suite}`])?.[1]
    const seen = new Set()
    const walk = file => {
      const path = resolve(root, file), rel = relative(root, path).replaceAll('\\', '/')
      if (seen.has(rel) || !existsSync(path) || rel.startsWith('../')) return
      seen.add(rel)
      const text = readFileSync(path, 'utf8')
      for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+\.(?:mjs|js|ts))['"]/g)) walk(relative(root, resolve(dirname(path), match[1])))
    }
    if (start) walk(start)
    graph.set(suite, seen)
  }
  return graph
}

export function suitesForPaths(paths, root, graph = suiteGraph(root)) {
  const known = [...graph.keys()], wanted = new Set()
  for (const path of paths.map(path => path.replaceAll('\\', '/'))) {
    let matched = false
    for (const [pattern, suites] of PATH_SUITES) if (pattern.test(path)) {
      matched = true
      for (const suite of suites === '*' ? known : suites) if (graph.has(suite)) wanted.add(suite)
    }
    for (const [suite, imports] of graph) if (imports.has(path)) { matched = true; wanted.add(suite) }
    // Unmapped executable changes are conservatively validated; documentation needs no browser run.
    if (!matched && /\.(?:[cm]?[jt]s|tsx?|css|html|json|glb)$/.test(path) && !path.startsWith('tests/')) for (const suite of known) wanted.add(suite)
  }
  return known.filter(suite => wanted.has(suite))
}

export function changedSuites(root, base, head = 'HEAD') {
  const paths = execFileSync('git', ['diff', '--name-only', '-z', `${base}...${head}`], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean)
  // Include tracked and untracked edits when a lane checks its unfinished work.
  if (head === 'HEAD') {
    paths.push(...execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean))
    paths.push(...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean))
  }
  return suitesForPaths(paths, root)
}
