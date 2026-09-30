import { git, json, tree } from './common.mjs'

const sections = ['Scripts and tooling', 'Dependencies', 'Tests and build/test execution', 'Product source', 'Assets']
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions', 'pnpm']
const code = /\.(?:[cm]?[jt]sx?|html|vue|svelte|py|sh|rs|wasm)$/i
const asset = /(?:^|\/)(?:assets|public|fixtures)\/|\.(?:png|jpe?g|gif|webp|svg|glb|gltf|bin|wasm|woff2?|ttf|otf|mp3|webm|ogg|wav)$/i
const inline = (value) => JSON.stringify(value ?? 'not recorded').replaceAll('`', '\\u0060')

/** Read committed data only. Neither configuration files nor package managers are loaded. */
export function reviewStage(root, base, head, touched, files = []) {
  const before = new Map(tree(root, base).map((e) => [e.path, e]))
  const after = new Map(tree(root, head).map((e) => [e.path, e]))
  const blob = (entries, path) => entries.has(path) ? git(root, ['cat-file', 'blob', entries.get(path).blob]).toString() : ''
  const parse = (text) => { try { return JSON.parse(text || '{}') } catch { return { malformed: true } } }
  const credits = parse(blob(after, 'src/support/open-source.json'))
  const creditEntries = Object.values(credits).flatMap((value) => Array.isArray(value) ? value : [])
  const groups = Object.fromEntries(sections.map((s) => [s, []]))
  const details = [], dependencyChanges = []
  for (const path of touched) {
    let assigned = false
    const put = (group) => { groups[group].push(path); assigned = true }
    const manifest = /(?:^|\/)package\.json$/.test(path)
    const tooling = /(?:^|\/)(?:scripts|\.github|\.circleci)\/|(?:^|\/)(?:[^/]*\.config\.[^/]+|wrangler\.[^/]+|tsconfig[^/]*\.json|\.?pnpmfile\.cjs|pnpm-workspace\.yaml|Dockerfile|Makefile|Jenkinsfile|\.gitlab-ci\.yml|azure-pipelines\.yml)$/.test(path)
    if (manifest || tooling) put('Scripts and tooling')
    if (manifest) {
      const old = parse(blob(before, path)), next = parse(blob(after, path))
      if (old.malformed || next.malformed) details.push(`${path}: invalid JSON; coordinator must inspect the entire manifest.`)
      if (json(old.scripts ?? {}) !== json(next.scripts ?? {})) details.push(`${path} scripts before: ${inline(old.scripts)}; after: ${inline(next.scripts)}.`)
      for (const field of dependencyFields) {
        if (json(old[field] ?? {}) === json(next[field] ?? {})) continue
        if (!groups.Dependencies.includes(path)) put('Dependencies')
        dependencyChanges.push(path)
        for (const name of new Set([...Object.keys(old[field] ?? {}), ...Object.keys(next[field] ?? {})])) {
          if (json(old[field]?.[name]) === json(next[field]?.[name])) continue
          details.push(`${path} ${field}: ${inline(name)} ${inline(old[field]?.[name])} -> ${inline(next[field]?.[name])}.`)
        }
      }
      put('Tests and build/test execution')
    }
    if (/(?:^|\/)(?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/.test(path)) { put('Dependencies'); dependencyChanges.push(path) }
    // Imported product modules can execute in tests or build plugins; flag them conservatively rather than claiming a complete static call graph.
    if (!manifest && (code.test(path) || tooling || /(?:^|\/)(?:tests?|e2e)\/|\.(?:test|spec)\./.test(path))) put('Tests and build/test execution')
    if (asset.test(path) || files.includes(`files/${path}`)) {
      put('Assets')
      const matches = creditEntries.filter((credit) => typeof credit === 'object' && credit && JSON.stringify(credit).includes(path))
      details.push(`${path}: before ${before.get(path)?.size ?? 0} bytes; after ${after.get(path)?.size ?? 0} bytes; ${files.includes(`files/${path}`) ? 'supplied through files/' : 'patch content'}; declared licences: ${matches.length ? matches.map((credit) => inline(credit.license)).join(', ') : 'not associated with a credit by path; coordinator must resolve'}.`)
    }
    if (/^(?:src|packages|worker|extension)\//.test(path) && !tooling && !manifest && !asset.test(path)) put('Product source')
    if (!assigned) put('Product source')
  }
  const oldLock = lockPackages(blob(before, 'pnpm-lock.yaml')), newLock = lockPackages(blob(after, 'pnpm-lock.yaml'))
  if (touched.includes('pnpm-lock.yaml')) {
    for (const [key, metadata] of newLock) {
      if (oldLock.get(key) === metadata) continue
      details.push(`Lock package ${inline(key)} (${oldLock.has(key) ? 'changed' : 'new'}): registry metadata ${inline(metadata)}. Licence: ${/\blicen[cs]e\s*:/.test(metadata) ? 'see recorded metadata' : 'not recorded in lockfile'}.`)
    }
    for (const key of oldLock.keys()) if (!newLock.has(key)) details.push(`Removed lock package ${inline(key)}.`)
    if (!newLock.size) details.push('No package records parsed; inspect the full lockfile, including registry, integrity, tarball and licence fields.')
  }
  if (groups.Assets.length) {
    details.push(`Asset credits from src/support/open-source.json (declared evidence; verify the asset association and permissive rights): ${inline(credits)}.`)
    details.push('A missing asset licence or provenance is unresolved; an empty credits record does not establish rights.')
  }
  const markdown = `# Astra review\n\nBase: ${base}\nHead: ${head}\n\nIntake applied and committed only. No install, build or tests executed.\nReview every path and the complete diff before appending a coordinator approval marker (\`approved:\` followed by your note). The tool never supplies that marker.\nGroups overlap: source modules may execute through test or build imports. Dependency changes are flagged, not refused; stage F0 may bring one physics engine within its brief.\n\n`
    + sections.map((s) => `## ${s}\n\n${groups[s].length ? groups[s].map((p) => `- \`${p}\``).join('\n') : 'None.'}\n`).join('\n')
    + `\n## Review details\n\n${details.length ? details.map((d) => `- ${d}`).join('\n') : 'No manifest, dependency or asset metadata changes.'}\n`
  return { markdown, groups, dependencyChanges: [...new Set(dependencyChanges)], lockChanged: touched.includes('pnpm-lock.yaml') }
}

/** Preserve package metadata verbatim as data, including fields this small parser does not interpret. */
function lockPackages(text) {
  const records = new Map(); let packages = false, key = null, lines = []
  const save = () => { if (key) records.set(key, lines.join('\n')) }
  for (const line of text.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) { packages = true; continue }
    if (!packages) continue
    if (/^\S/.test(line)) break
    const match = /^  (.+):\s*$/.exec(line)
    if (match) { save(); key = match[1].replace(/^['"]|['"]$/g, ''); lines = [] }
    else if (key) lines.push(line.trimEnd())
  }
  save(); return records
}
