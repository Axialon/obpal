/** Deterministic projections of the reviewed canonical source; development files are never rewritten here. */
import * as ts from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/sync'
import { createVirtualFileSystem } from 'typescript/unstable/fs'
import { resolve } from 'node:path'

const bad = message => { throw new Error(`Public projection: ${message}`) }
const parse = text => {
  // TypeScript 7 exposes parsing through its short-lived native compiler API. This writes no project files.
  const file = resolve('__public_projection__/profile.ts').replaceAll('\\', '/')
  const config = resolve('__public_projection__/tsconfig.json').replaceAll('\\', '/')
  const api = new API({ fs: createVirtualFileSystem({ [file]: text,
    [config]: JSON.stringify({ files: ['profile.ts'], compilerOptions: { noLib: true, noResolve: true, types: [] } }) }) })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    try {
      const program = snapshot.getProject(config).program
      if (program.getSyntacticDiagnostics(file).length) bad('malformed source')
      return program.getSourceFile(file)
    } finally { snapshot.dispose() }
  } finally { api.close() }
}
const identifier = (node, name) => ts.isIdentifier(node) && node.text === name
const literal = node => ts.isStringLiteral(node) ? node.text : identifier(node, 'LOCAL_CATEGORY') ? 'local' : null
function property(object, name) {
  if (!ts.isObjectLiteralExpression(object)) bad('unknown object row')
  const names = object.properties.map(p => {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name)) bad('unknown object property structure')
    return p.name.text
  })
  if (new Set(names).size !== names.length) bad('duplicate object property')
  const found = object.properties.filter(p => ts.isPropertyAssignment(p) &&
    (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name)
  if (found.length !== 1) bad(`missing or duplicate ${name}`)
  return found[0].initializer
}
function variables(source) {
  const found = new Map()
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (!found.has(node.name.text)) found.set(node.name.text, [])
      found.get(node.name.text).push(node)
    }
    node.forEachChild(visit)
  }
  visit(source)
  return name => { const list = found.get(name); if (list?.length !== 1) bad(`unknown binding ${name}`); return list[0] }
}
const arrayText = nodes => `[\n${nodes.map(node => `  ${node.getText()},`).join('\n')}\n]`
const objectText = nodes => `{\n${nodes.map(node => `  ${node.getText()},`).join('\n')}\n}`
const replace = (node, text) => ({ start: node.getStart(), end: node.getEnd(), text })
function remove(statement, source) {
  let end = statement.getEnd()
  if (source.text.slice(end, end + 2) === '\r\n') end += 2
  else if (source.text[end] === '\n') end++
  return { start: statement.getStart(), end, text: '' }
}
function edited(text, edits) {
  let previous = text.length + 1
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    if (e.end > previous) bad('overlapping projection edits')
    text = text.slice(0, e.start) + e.text + text.slice(e.end); previous = e.start
  }
  parse(text)
  return text
}

const privateItems = new Set(['cvc-insignia', 'cvc-wordmark', 'mmc-insignia', 'mmc-wordmark', 'k9c-insignia', 'k9c-wordmark',
  'cc-insignia', 'cc-wordmark', 'factions', 'boxem', 'orbitem', 'pulseem', 'capem', 'synthem', 'balancem',
  'cost', 'quality', 'scope', 'time', 'aerospace', 'architecture', 'biomedical', 'vfx', 'software'])
const categories = new Set(['cvc', 'engines', 'pillars', 'industries', 'studio', 'local'])
const builders = { cube: 'orientationCube', knot: 'knot', gem: 'gem' }

/** Change only named catalogue bindings/imports; the original Studio geometry and interaction bodies stay byte-identical. */
export function projectPublicCatalog(text, policy) {
  if (policy.schema !== 1 || policy.profile !== 'public-demo-v1' ||
    JSON.stringify(policy.catalog) !== JSON.stringify({ items: ['cube', 'knot', 'gem'], categories: ['studio', 'local'], defaultId: 'cube' })) bad('unknown profile')
  const source = parse(text), binding = variables(source), edits = []
  const allowedVariables = new Set(['LOCAL_CATEGORY', 'CATEGORY_ART', 'CATEGORIES', 'CATALOG', 'DEFAULT_ITEM', 'cvc', 'engine', 'box'])
  const allowedFunctions = new Set(['setCategoryItems', 'faceMark', 'orientationCube', 'knot', 'gem'])
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const module = statement.moduleSpecifier.text
      if (module === './boxem-core') edits.push(remove(statement, source))
      else if (!['three', 'three/addons/geometries/RoundedBoxGeometry.js'].includes(module)) bad('unknown catalogue import')
    } else if (ts.isVariableStatement(statement)) {
      if (statement.declarationList.declarations.length !== 1) bad('unknown grouped binding')
      const declaration = statement.declarationList.declarations[0]
      if (!ts.isIdentifier(declaration.name) || !allowedVariables.has(declaration.name.text)) bad('unknown catalogue binding')
      if (['cvc', 'engine', 'box'].includes(declaration.name.text)) {
        if (!ts.isArrowFunction(declaration.initializer)) bad('unknown restricted helper')
        edits.push(remove(statement, source))
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      if (!statement.name || !allowedFunctions.has(statement.name.text)) bad('unknown catalogue function')
    } else if (!ts.isInterfaceDeclaration(statement) || !['Category', 'CatalogItem'].includes(statement.name.text)) bad('unknown catalogue statement')
  }
  if (literal(binding('LOCAL_CATEGORY').initializer) !== 'local') bad('changed local category')
  const cat = binding('CATEGORIES').initializer
  if (!ts.isArrayLiteralExpression(cat)) bad('unknown categories')
  const catIds = cat.elements.map(row => literal(property(row, 'id')))
  if (new Set(catIds).size !== catIds.length || catIds.some(id => !categories.has(id))) bad('unreviewed category')
  const publicCats = cat.elements.filter((_, i) => policy.catalog.categories.includes(catIds[i]))
  if (publicCats.length !== 2) bad('missing public category')
  edits.push(replace(cat, arrayText(publicCats)))
  const art = binding('CATEGORY_ART').initializer
  if (!ts.isObjectLiteralExpression(art)) bad('unknown category artwork')
  const arts = art.properties.map(p => {
    if (!ts.isPropertyAssignment(p)) bad('unknown category artwork row')
    const id = ts.isComputedPropertyName(p.name) ? literal(p.name.expression) : ts.isIdentifier(p.name) ? p.name.text : literal(p.name)
    if (!categories.has(id)) bad('unreviewed category artwork')
    return { id, node: p }
  })
  const selectedArt = arts.filter(p => policy.catalog.categories.includes(p.id))
  if (selectedArt.length !== 2) bad('missing public artwork')
  edits.push(replace(art, objectText(selectedArt.map(p => p.node))))
  const catalog = binding('CATALOG').initializer
  if (!ts.isArrayLiteralExpression(catalog)) bad('unknown catalogue')
  const selected = [], seen = new Set()
  for (const row of catalog.elements) {
    const call = ts.isCallExpression(row), id = call ? literal(row.arguments[0]) : literal(property(row, 'id'))
    if (!id || seen.has(id)) bad('unknown or duplicate catalogue item')
    seen.add(id)
    if (privateItems.has(id)) {
      if (call && (!ts.isIdentifier(row.expression) || !['cvc', 'engine', 'box'].includes(row.expression.text))) bad('unknown restricted row')
      continue
    }
    if (!Object.hasOwn(builders, id) || call || literal(property(row, 'category')) !== 'studio' ||
      !identifier(property(row, 'make'), builders[id]) || row.properties.some(p => !['id', 'name', 'category', 'subtitle', 'color', 'glyph', 'make'].includes(p.name.text))) bad('unreviewed public item')
    selected.push(row)
  }
  if (JSON.stringify(selected.map(row => literal(property(row, 'id')))) !== JSON.stringify(policy.catalog.items)) bad('missing public item')
  edits.push(replace(catalog, arrayText(selected)))
  const fallback = binding('DEFAULT_ITEM').initializer
  if (!['cvc-insignia', 'cube'].includes(literal(fallback))) bad('unknown default')
  edits.push(replace(fallback, JSON.stringify('cube')))
  const out = edited(text, edits)
  if (/boxemCore|models\/(?:cvc|blackboxes)|cvc-insignia/.test(out)) bad('restricted catalogue reference survived')
  return out
}

/** Remove only the known insignia loader and replace its rows with the existing neutral puck labels. */
export function projectPublicArena(text) {
  const source = parse(text), binding = variables(source), factions = binding('FACTIONS').initializer
  if (!ts.isArrayLiteralExpression(factions) || factions.elements.length !== 4) bad('unknown arena factions')
  const names = ['CVC', 'CC', 'K9C', 'MMC'], rows = factions.elements.map(row => [literal(property(row, 'faction')), literal(property(row, 'model'))])
  const neutral = rows.every(([name, model], i) => name === `Team ${i + 1}` && model === '')
  if (neutral) {
    if (/models\/cvc|GLTFLoader|loader\.load/.test(text)) bad('stale arena loader')
    return text
  }
  if (!rows.every(([name, model], i) => name === names[i] && model === `/models/cvc/${names[i]}_insignia.glb`)) bad('unreviewed arena model')
  const edits = [replace(factions, `[\n${names.map((_, i) => `  { faction: 'Team ${i + 1}', model: '' },`).join('\n')}\n]`)]
  let loaders = 0, declarations = 0, imports = 0
  const visit = node => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'three/addons/loaders/GLTFLoader.js') { edits.push(remove(node, source)); imports++ }
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const list = node.importClause.namedBindings.elements
      if (list.some(p => p.name.text === 'modelFailed')) {
        const kept = list.filter(p => p.name.text !== 'modelFailed')
        edits.push(replace(node.importClause.namedBindings, `{ ${kept.map(p => p.getText()).join(', ')} }`))
      }
    }
    if (ts.isVariableDeclaration(node) && identifier(node.name, 'loader')) {
      if (!ts.isNewExpression(node.initializer) || !identifier(node.initializer.expression, 'GLTFLoader')) bad('unknown arena loader')
      edits.push(remove(node.parent.parent, source)); declarations++
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) &&
      identifier(node.expression.expression.expression, 'loader') && node.expression.expression.name.text === 'load') {
      edits.push(remove(node, source)); loaders++
    }
    node.forEachChild(visit)
  }
  visit(source)
  if (loaders !== 1 || declarations !== 1 || imports !== 1) bad('unknown arena loader structure')
  const out = edited(text, edits)
  if (/models\/cvc|GLTFLoader|loader\.load/.test(out)) bad('restricted arena reference survived')
  return out
}

const omitted = '<section class="film-grid" aria-label="Public demo media"><p>Promotional films are not included in this public demo. The original media remain outside this redistributable profile.</p></section>'
function checkedCampaign(text) {
  if (/<video\b|campaign\/films\//i.test(text)) bad('stale film reference survived')
  return text
}
/** The admitted frozen HTML has one film grid without nested sections; unfamiliar structures require review. */
export function projectPublicCampaign(text) {
  if (text.includes(omitted)) return checkedCampaign(text)
  const opening = '<section class="film-grid" aria-label="Six complete films">', start = text.indexOf(opening)
  const end = text.indexOf('</section>', start)
  if (start < 0 || end < 0 || text.indexOf(opening, start + 1) >= 0 || text.slice(start + opening.length, end).includes('<section')) bad('unknown campaign grid')
  const grid = text.slice(start, end)
  if ((grid.match(/<video\b/g) ?? []).length !== 6 || (grid.match(/Download MP4/g) ?? []).length !== 6) bad('unknown campaign inventory')
  let out = text.slice(0, start) + omitted + text.slice(end + '</section>'.length)
  // Keep the original page/enquiry shell; do not promise films the public profile does not include.
  out = out.replace(/<p class="film-lede">[^<]*<\/p>/, '<p class="film-lede">Explore the open public demo. Promotional media are distributed separately.</p>')
    .replace('See ob.Pal in motion: six complete films of historical simulations, ready to watch, download and share with partners and supporters.',
      'Explore the ob.Pal public demo. Promotional films are not included in this redistributable profile.')
  return checkedCampaign(out)
}

export function projectPublicFilmManifest(text) {
  let value
  try { value = JSON.parse(text) } catch { bad('malformed film manifest') }
  if (!value || Object.keys(value).sort().join(',') !== 'audio,films' || typeof value.audio !== 'string' || !Array.isArray(value.films) ||
    value.films.length !== 0 && value.films.length !== 6) bad('unknown film manifest')
  return JSON.stringify({ audio: 'Promotional films are not included in this public demo.', films: [] }, null, 2) + '\n'
}

export function projectPublicFilmAssets(text, manifestText) {
  projectPublicFilmManifest(manifestText)
  const inventory = JSON.parse(manifestText).films
  const source = parse(text), declaration = variables(source)('FILM_ASSETS'), value = declaration.initializer
  const imports = source.statements.filter(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === '../public/campaign/films/manifest.json')
  const type = 'readonly { file: string; bytes: number; sha256: string }[]'
  if (ts.isPropertyAccessExpression(value) && identifier(value.expression, 'filmManifest') && value.name.text === 'films') {
    if (inventory.length !== 0 || imports.length !== 1 || imports[0].importClause?.name?.text !== 'filmManifest' ||
      imports[0].importClause.namedBindings || declaration.type?.getText().replace(/\s+/g, ' ') !== type) bad('unknown projected film inventory')
    return text
  }
  if (imports.length || !ts.isAsExpression(value) || value.type.getText() !== 'const' || !ts.isArrayLiteralExpression(value.expression) ||
    value.expression.elements.length !== 6 || inventory.length !== 6) bad('unknown frozen film inventory')
  const names = new Set()
  for (const [i, row] of value.expression.elements.entries()) {
    const file = literal(property(row, 'file')), bytes = property(row, 'bytes'), sha = literal(property(row, 'sha256'))
    if (row.properties.length !== 3 || !ts.isNumericLiteral(bytes) || file !== inventory[i].file || Number(bytes.text) !== inventory[i].bytes ||
      sha !== inventory[i].sha256 || !/^[a-f0-9]{64}$/.test(sha) || !/^obpal-[a-z-]+\.mp4$/.test(file) || names.has(file)) bad('unreviewed film row')
    names.add(file)
  }
  const statement = declaration.parent.parent
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1 ||
    !statement.modifiers?.some(node => node.kind === ts.SyntaxKind.ExportKeyword)) bad('unknown film binding')
  const edits = [replace(statement, `import filmManifest from '../public/campaign/films/manifest.json'\nexport const FILM_ASSETS: ${type} = filmManifest.films`)]
  const comment = '/** Only the six reviewed campaign exports. Tests bind these receipts to the public manifest. */'
  if (!text.startsWith(comment)) bad('unknown film inventory header')
  edits.push({ start: 0, end: comment.length, text: '/** The public demo inventory derives from its projected manifest; omitted films have no media route. */' })
  return edited(text, edits)
}
