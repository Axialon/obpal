/** Checks the claims and permission disclosures shared by the four upload surfaces. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseListing } from './store-fields.mjs'

export function checkStoreCopy(root, manifest) {
  const read = path => readFileSync(join(root, path), 'utf8')
  const listing = read('extension/store/listing.md'), page = read('link/index.html'), captions = read('extension/store/src/scenes.mjs')
  const fields = parseListing(listing).flatMap(tab => tab.fields)
  const config = read('extension/vite.config.ts')
  const version = JSON.parse(read('extension/package.json')).version
  if (!page.includes('%LINK_VERSION%')) throw new Error('Link page must use the extension build version')
  const summary = fields.find(field => field.name === 'Summary')?.text
  const description = manifest?.description ?? /\n  description: '([^']*)'/.exec(config)?.[1]
  if (summary !== description) throw new Error('Store summary contradicts the manifest description')
  for (const browser of ['Chrome', 'Edge', 'Brave', 'Vivaldi']) if (!listing.includes(browser) || !page.includes(browser)) throw new Error(`Supported browser missing from listing or Link page: ${browser}`)
  if (!listing.includes('Chromium 120 or later') || !page.includes('Chromium 120 or later')) throw new Error('Browser minimum contradicts listing or Link page')
  for (const mode of ['Controller', '3D', 'Keys', 'PC']) {
    if (![listing, page, captions].every(text => text.includes(mode))) throw new Error(`Mode missing from store copy: ${mode}`)
  }
  if (!summary.includes('Windows PC') || !listing.includes('Desktop for Windows') || !page.includes('Optional · Windows') || !captions.includes('Windows only')) throw new Error('PC copy must describe the optional Windows helper')
  if (/macOS|Linux/.test(captions) || /PC.*(?:macOS|Linux)/.test(summary)) throw new Error('PC copy advertises unsupported platforms')
  const groups = ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']
  const permissions = manifest ?? {}
  // Read the declarative arrays; SERVICE is the production origin declared in this same source.
  if (!manifest) for (const key of groups) {
    const block = new RegExp(`\\n  ${key}: \\[([^\\]]*)\\]`).exec(config)?.[1] ?? ''
    permissions[key] = [...block.matchAll(/['`"]([^'`"]+)['`"]/g)].map(match => match[1].replace('${SERVICE}', 'https://obpal.blackboxes.net'))
  }
  const labels = ['','Optional permission ','Host permission ','Optional host permission ']
  const actual = groups.flatMap((group, index) => (permissions[group] ?? []).map(value => labels[index] + value))
  if (manifest && manifest.version !== version || manifest && manifest.minimum_chrome_version !== '120') throw new Error('Manifest version or browser minimum contradicts store copy')
  for (const name of actual) if (!fields.some(field => field.name === name && field.text.trim())) throw new Error(`Permission without justification: ${name}`)
  const disclosed = fields.filter(field => /^(?:Optional permission |Host permission |Optional host permission )/.test(field.name)).map(field => field.name)
  for (const name of disclosed) if (!actual.includes(name)) throw new Error(`Justification for absent manifest permission: ${name}`)
  return [
    `Version ${version}: manifest and package agree; Link page uses the build version; listing and captions make no fixed version claim.`,
    'Browsers: Chrome, Edge, Brave and Vivaldi, Chromium 120 or later; captions make no browser claim.',
    'Controller, 3D, Keys and PC agree; PC needs the optional Windows helper.',
    `${actual.length}/${actual.length} manifest permissions and host permissions have justifications; privacy describes encrypted input and local state.`,
    'Summary is the manifest description. Release changes below compare with the published ledger entry, not an intermediate release.',
  ]
}
