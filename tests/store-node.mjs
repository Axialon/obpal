/** Node-side raster and git fixtures, with no file writes during tests. */
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { readText, readBytes, bytes } from './devtools-node.mjs'
import { renderIcons, toolbarMark } from '../extension/scripts/icons.mjs'
import { iconPixels, iconDifference } from '../extension/store/src/icon-compare.mjs'
import { compareFields, parseListing, changedParagraphs } from '../extension/scripts/store-fields.mjs'

export { readText, readBytes, toolbarMark, changedParagraphs, parseListing, compareFields }
export const baselineText = () => execFileSync('git', ['show', 'a4f0ff0:extension/store/listing.md'], { encoding: 'utf8' })
export const iconFixtures = async () => ({ source: readText('public/logo-mark.svg'), icons: await renderIcons() })
export const referencePixels = async () => sharp(bytes(readText('public/logo-mark.svg')), { density: 288 }).resize(96, 96).ensureAlpha().raw().toBuffer()
export const compareIcon = async (png, pad, ref) => iconDifference(await iconPixels(png, pad), ref)
export const oldStoreIcon = () => execFileSync('git', ['show', 'a4f0ff0:extension/store/icon-128.png'])
export const alphaPixels = png => sharp(png).ensureAlpha().raw().toBuffer()
export const imageInfo = path => sharp(readBytes(path)).metadata()
