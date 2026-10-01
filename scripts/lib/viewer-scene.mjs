/** The viewer's replacement lifecycle, through its catalogue and file input. */
export async function runViewerScene(browser, origin, check) {
  for (const width of [1280, 390]) {
    await check(`viewer at ${width}px switches through every model with only its named staging`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 } })
      try {
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(origin + '/view/')
        await page.waitForFunction(() => window.__viewer?.holder.children.length === 1)
        const categories = await page.locator('.cat-btn').evaluateAll(buttons => buttons.map(b => b.dataset.cat))
        const items = []
        for (const category of categories) {
          await openCategory(page, category)
          items.push(...await page.locator('.tile').evaluateAll((tiles, category) => tiles.map(t => ({ id: t.dataset.id, category })), category))
        }
        if (items.length < 27) throw new Error(`only ${items.length} built-in models found`)
        for (const item of items) {
          // Listen on the old model's real resources, rather than estimating disposal from root counts.
          await page.evaluate(() => {
            const { holder, parts } = window.__viewer
            const wrap = holder.children[0], root = wrap.children[0], resources = new Set()
            root.traverse(o => {
              if (o.geometry) resources.add(o.geometry)
              for (const mat of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
                resources.add(mat)
                Object.values(mat).filter(v => v?.isTexture).forEach(v => resources.add(v))
              }
            })
            window.__viewerDisposal = { wrap, records: [...resources].map(resource => {
              const record = { type: resource.type, count: 0 }
              resource.addEventListener('dispose', () => { record.count++ })
              return record
            }) }
            parts.select(parts.objectPart(root))
          })
          await pick(page, item)
          await assertScene(page, item.id)
          const disposed = await page.evaluate(() => {
            const { wrap, records } = window.__viewerDisposal
            return { detached: wrap.parent === null, records }
          })
          if (!disposed.detached || !disposed.records.length || disposed.records.some(r => r.count !== 1)) throw new Error(`${item.id}: old model disposal ${JSON.stringify(disposed)}`)
          const selection = await page.evaluate(() => {
            const hand = window.__viewer.parts.host
            return !!(hand.selected || hand.hovered || hand.fade || hand.halo.visible)
          })
          if (selection) throw new Error(`${item.id}: selection survives replacement`)
        }
        // Explicit additions remain supported; an ordinary pick replaces the entire row again.
        await openCategory(page, 'studio')
        await page.locator('.tile[data-id="cube"] .tile-add').click()
        await page.waitForFunction(() => window.__viewer.holder.children.length === 2)
        await pick(page, { id: 'gem', category: 'studio' })
        await assertScene(page, 'gem')
        if (errors.length) throw new Error(errors.join(' | '))
        return `${items.length} replacements, resources disposed, selection cleared; explicit add then replace`
      } finally { await context.close() }
    })
  }
  await check('viewer keeps the newest pick when an older GLB or dropped file finishes later', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    let release = () => {}
    try {
      const page = await context.newPage()
      await page.goto(origin + '/view/')
      await page.waitForFunction(() => window.__viewer?.holder.children.length === 1)
      let asked = () => {}
      const requested = new Promise(resolve => { asked = resolve })
      const gate = new Promise(resolve => { release = resolve })
      await context.route('**/models/cvc/MMC_insignia.glb', async route => { asked(); await gate; await route.continue() })
      await openCategory(page, 'cvc')
      await page.locator('.tile[data-id="mmc-insignia"]').click()
      await Promise.race([requested, page.waitForTimeout(15000).then(() => { throw new Error('delayed model was never requested') })])
      await pick(page, { id: 'cc-insignia', category: 'cvc' })
      const response = page.waitForResponse('**/models/cvc/MMC_insignia.glb')
      release()
      await (await response).finished()
      await page.waitForTimeout(500)
      await assertScene(page, 'cc-insignia')
      await context.unroute('**/models/cvc/MMC_insignia.glb')

      // Delay the actual STL read before a newer catalogue pick. This exercises the file path's request token.
      await page.evaluate(() => {
        const original = File.prototype.arrayBuffer
        const bytes = new ArrayBuffer(134), data = new DataView(bytes)
        data.setUint32(80, 1, true)
        ;[0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => data.setFloat32(84 + i * 4, v, true))
        File.prototype.arrayBuffer = function () {
          if (this.name !== 'delayed.stl') return original.call(this)
          window.__viewerFileWaiting = true
          return new Promise(resolve => { window.__viewerReleaseFile = () => { File.prototype.arrayBuffer = original; resolve(bytes) } })
        }
        const input = document.querySelector('#file'), transfer = new DataTransfer()
        transfer.items.add(new File([bytes], 'delayed.stl'))
        input.files = transfer.files
        input.dispatchEvent(new Event('change'))
      })
      await page.waitForFunction(() => window.__viewerFileWaiting)
      await pick(page, { id: 'knot', category: 'studio' })
      await page.evaluate(() => window.__viewerReleaseFile())
      await page.waitForTimeout(500)
      await assertScene(page, 'knot')
      return 'delayed catalogue GLB and STL both lost to the newer pick'
    } finally { release(); await context.close() }
  })
}

async function pick(page, item) {
  const previous = await page.evaluate(() => window.__viewer.holder.children[0]?.uuid)
  await openCategory(page, item.category)
  // A deliberately pinned old selection can cover the phone rail or tiles. Exercise the picker handler directly.
  await page.locator(`.tile[data-id="${item.id}"]`).evaluate(tile => tile.click())
  await page.waitForFunction(({ id, previous }) => {
    const roots = window.__viewer.holder.children
    return roots.length === 1 && roots[0].name === `model:${id}` && roots[0].uuid !== previous
  }, { id: item.id, previous })
  // Keep the mouse away from the model so hover feedback does not obscure lifecycle assertions.
  await page.mouse.move(0, 0)
}

async function openCategory(page, category) {
  const button = page.locator(`.cat-btn[data-cat="${category}"]`)
  if (await button.getAttribute('aria-selected') !== 'true') await button.evaluate(button => button.click())
}

async function assertScene(page, id) {
  const state = await page.evaluate(() => {
    const holder = window.__viewer.holder, scene = holder.parent
    return {
      roots: holder.children.map(root => ({ name: root.name, children: root.children.length })),
      stage: scene.children.filter(o => o !== holder).map(o => ({ name: o.name, type: o.type })),
      presence: scene.getObjectByName('shared-presence').children.length,
      contactShadows: scene.children.filter(o => o.name === 'model-contact-shadow').map(o => o.visible),
    }
  })
  const expected = [
    ['studio-key', 'DirectionalLight'], ['studio-rim', 'DirectionalLight'], ['studio-fill', 'HemisphereLight'],
    ['studio-grid', 'Mesh'], ['studio-shadow', 'Mesh'], ['selection-host', 'Mesh'],
    ['shared-presence', 'Group'], ['presence-rig', 'Group'], ['model-contact-shadow', 'Mesh'],
  ].map(([name, type]) => ({ name, type }))
  if (JSON.stringify(state.roots) !== JSON.stringify([{ name: `model:${id}`, children: 1 }]) ||
      JSON.stringify(state.stage) !== JSON.stringify(expected) || state.presence !== 0 ||
      JSON.stringify(state.contactShadows) !== '[false]') throw new Error(`${id}: unexpected scene ${JSON.stringify(state)}`)
}
