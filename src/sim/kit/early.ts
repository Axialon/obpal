/**
 * The first script of every page that shows a Blender mesh (the arm sim and the device sims). It reads which mesh the
 * page will need from the address and starts its download and its decoder at once, and shows the loading pill: the
 * download then runs beside the page's own scripts (three.js, the sim, its device) instead of after them, and is done
 * by the time the scene exists. Built device pages also name the mesh in a <link rel="preload"> (scripts/lib/seo.mjs).
 * Small on purpose: it imports nothing that needs three.js (./models.ts, ./loading.ts).
 */
import { expectRig } from './loading'
import { downloadPrototype, pageModels } from './models'
import { modelFailed, sceneFailed } from './recovery'
import { holdReload } from '../../ui/recover'

// A shared visitor must keep its authenticated scene link across a failed import.
holdReload(() => new URLSearchParams(location.search).get('join') === '1')
addEventListener('obpal:model-failed', modelFailed)
// A module that never loads cannot reach its page boundary.
addEventListener('error', event => {
  if (event.target instanceof HTMLScriptElement && event.target.type === 'module') sceneFailed(event)
}, true)

const wanted = pageModels(location.pathname, location.search)
if (wanted.length) {
  for (const name of wanted) void downloadPrototype(name)
  expectRig()
}
