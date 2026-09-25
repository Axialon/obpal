// Copy shared Blackboxes sources (canonical in the BlackBoxes repo) into this repo:
//   shared/family/{family.css,family.js}         -> src/family/        (design system)
//   shared/{model-core.js,spatial-drag.js}       -> src/vendor/blackboxes/ (trade-off models: solver + radial mapping)
// Usage: node scripts/sync-family.mjs [path-to-BlackBoxes]   (default: ../BlackBoxes, or $BLACKBOXES_DIR)
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const here = join(import.meta.dirname, '..')
const root = resolve(process.argv[2] ?? process.env.BLACKBOXES_DIR ?? join(here, '..', 'BlackBoxes'))
const shared = join(root, 'shared')
if (!existsSync(join(shared, 'family'))) {
  console.error(`No Blackboxes shared sources at ${shared}`)
  process.exit(1)
}
const copies = [
  ['family/family.css', 'src/family/family.css'],
  ['family/family.js', 'src/family/family.js'],
  ['model-core.js', 'src/vendor/blackboxes/model-core.js'],
  ['spatial-drag.js', 'src/vendor/blackboxes/spatial-drag.js'],
]
mkdirSync(join(here, 'src', 'vendor', 'blackboxes'), { recursive: true })
for (const [from, to] of copies) copyFileSync(join(shared, from), join(here, to))
console.log(`Synced ${copies.length} files from ${shared}`)
