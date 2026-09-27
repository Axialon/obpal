/**
 * Which open-source work ob.Pal uses, and whether the donate page's give-back list (src/support/open-source.json)
 * credits all of it: every dependency in the package.json files and desktop/Cargo.toml, and the fonts the site serves
 * and ob.Pal Link bundles (which must also have their licence beside them, to ship with them). Prints each credited
 * project's share, and fails if anything is missing or the shares don't add up to 100.
 */
import { existsSync, readFileSync } from 'node:fs'

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const list = JSON.parse(read('src/support/open-source.json'))
const used = new Map()
for (const f of ['package.json', 'packages/core/package.json', 'packages/host/package.json', 'extension/package.json']) {
  const p = JSON.parse(read(f))
  for (const [kind, deps] of [['runtime', p.dependencies], ['tooling', p.devDependencies]]) {
    for (const name of Object.keys(deps ?? {})) if (!name.startsWith('@obpal/')) used.set(`npm:${name}`, used.get(`npm:${name}`) === 'runtime' ? 'runtime' : kind)
  }
}
const cargo = read('desktop/Cargo.toml').split('[dependencies]')[1]?.split(/\n\[/)[0] ?? ''
for (const m of cargo.matchAll(/^([a-z0-9_-]+)\s*=/gm)) used.set(`crate:${m[1]}`, 'runtime')
// The fonts the site serves and the ones ob.Pal Link bundles (their @font-face rules), each with its SIL OFL text
// beside the font files.
const unlicensed = []
for (const [css, dir] of [['src/styles/fonts.css', 'public/fonts'], ['extension/src/ui/link.css', 'extension/src/fonts']]) {
  for (const m of read(css).matchAll(/@font-face\s*{[^}]*?font-family:\s*'([^']+)'/g)) {
    used.set(`font:${m[1]}`, 'runtime')
    const licence = `${dir}/OFL-${m[1].replace(/\s+/g, '')}.txt`
    if (!existsSync(new URL(`../${licence}`, import.meta.url)) && !unlicensed.includes(licence)) unlicensed.push(licence)
  }
}

const credited = new Map()
for (const e of [...list.upstream, ...list.thanks]) {
  for (const n of e.packages ?? []) credited.set(`npm:${n}`, e.name)
  for (const n of e.crates ?? []) credited.set(`crate:${n}`, e.name)
  for (const n of e.fonts ?? []) credited.set(`font:${n}`, e.name)
}
const total = list.upstream.reduce((s, u) => s + u.share, 0)
console.log('Give-back shares (the donate page):')
for (const u of list.upstream) console.log(`  ${String(u.share).padStart(3)}%  ${u.name.padEnd(20)} ${u.give}`)
const missing = [...used].filter(([k]) => !credited.has(k))
console.log(`\n${used.size} dependencies and fonts, ${used.size - missing.length} credited.`)
for (const [k, kind] of missing) console.log(`  not credited: ${k} (${kind})`)
for (const f of unlicensed) console.log(`  no licence beside a font that ships: ${f}`)
if (total !== 100) console.log(`  shares add up to ${total}, not 100`)
process.exit(missing.length || unlicensed.length || total !== 100 ? 1 : 0)
