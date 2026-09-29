import { afterEach, describe, expect, it } from 'vitest'
import { carryKept, deployedSite, keepBuild, keptBuilds, KEEP_BUILDS, listFiles } from '../scripts/lib/keep-assets.mjs'
import { joinPath, readAsset, removeTemp, tempDir, writeRedirect, writeSite } from './keep-assets-node.mjs'

afterEach(removeTemp)

/** One deploy the way scripts/keep-assets.mjs makes it: carry, deploy, keep. Returns what the deployed site held. */
function deploy(root: string, store: string, files: Record<string, string>) {
  const site = writeSite(root, files)
  const moved = carryKept({ site, store })
  const served = listFiles(joinPath(site, 'assets'))
  keepBuild({ site, store, fresh: moved.fresh })
  return { served, moved, site }
}

describe('keeping the last builds across a deploy', () => {
  it('carries in the files the new build lacks, and the new build\'s own file wins a name both hold', () => {
    const root = tempDir()
    const store = joinPath(root, 'kept')
    deploy(root, store, { 'viewer-old.js': 'old viewer', 'qr-old.js': 'old qr', 'font-same.woff2': 'the old copy' })
    const next = deploy(root, store, { 'viewer-new.js': 'new viewer', 'qr-new.js': 'new qr', 'font-same.woff2': 'the new copy' })
    expect(next.served).toEqual(['font-same.woff2', 'qr-new.js', 'qr-old.js', 'viewer-new.js', 'viewer-old.js'])
    expect(next.moved.carried).toEqual(['qr-old.js', 'viewer-old.js'])
    expect(next.moved.fresh).toEqual(['font-same.woff2', 'qr-new.js', 'viewer-new.js'])
    expect(readAsset(next.site, 'qr-old.js')).toBe('old qr')
    expect(readAsset(next.site, 'font-same.woff2')).toBe('the new copy')
  })

  it('keeps each build\'s chunks through the two deploys after it, and no longer', () => {
    expect(KEEP_BUILDS).toBe(2)
    const root = tempDir()
    const store = joinPath(root, 'kept')
    const shared = { 'three-shared.js': 'unchanged' }
    const serves = [1, 2, 3, 4].map((n) => deploy(root, store, { ...shared, [`qr-${n}.js`]: `qr ${n}` }).served)
    expect(serves[0]).toEqual(['qr-1.js', 'three-shared.js'])
    expect(serves[1]).toEqual(['qr-1.js', 'qr-2.js', 'three-shared.js'])
    expect(serves[2]).toEqual(['qr-1.js', 'qr-2.js', 'qr-3.js', 'three-shared.js'])
    // The fourth deploy is the first that no longer holds the first build's chunk.
    expect(serves[3]).toEqual(['qr-2.js', 'qr-3.js', 'qr-4.js', 'three-shared.js'])
    expect(keptBuilds(store)).toEqual(['000004', '000003'])
  })

  it('keeps the whole of a build, the chunks it shares with the one before included', () => {
    const root = tempDir()
    const store = joinPath(root, 'kept')
    deploy(root, store, { 'shared.js': 'x', 'a-1.js': 'a1' })
    deploy(root, store, { 'shared.js': 'x', 'a-2.js': 'a2' })
    expect(listFiles(joinPath(store, '000002', 'assets'))).toEqual(['a-2.js', 'shared.js'])
    const third = deploy(root, store, { 'shared.js': 'x', 'a-3.js': 'a3' })
    expect(third.moved.carried).toEqual(['a-2.js', 'a-1.js'])
  })

  it('keeps a build deployed again once, so a retry does not push the last real build out', () => {
    const root = tempDir()
    const store = joinPath(root, 'kept')
    deploy(root, store, { 'a-1.js': '1' })
    deploy(root, store, { 'a-2.js': '2' })
    const site = writeSite(root, { 'a-2.js': '2' })
    const moved = carryKept({ site, store })
    expect(keepBuild({ site, store, fresh: moved.fresh })).toBeNull()
    expect(keptBuilds(store)).toEqual(['000002', '000001'])
  })

  it('needs nothing kept: the first deploy carries nothing, and a build with no assets is refused', () => {
    const root = tempDir()
    const store = joinPath(root, 'kept')
    expect(deploy(root, store, { 'a-1.js': '1' }).moved.carried).toEqual([])
    expect(() => carryKept({ site: joinPath(root, 'nothing'), store })).toThrow(/no build/)
  })

  it('finds the site wrangler deploys through the redirected config the build writes', () => {
    const root = tempDir()
    writeRedirect(root)
    expect(deployedSite(root)).toBe(joinPath(root, 'dist', 'client'))
    expect(() => deployedSite(tempDir())).toThrow(/pnpm run build/)
  })
})
