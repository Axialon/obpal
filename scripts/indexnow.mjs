/** Notify IndexNow of every URL in the deployed sitemap. A notification failure does not fail a deploy. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE } from './lib/preview.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  const keyFile = readdirSync(join(root, 'public')).find(f => /^[a-f0-9]{32}\.txt$/.test(f))
  if (!keyFile) throw new Error('The IndexNow key file is missing')
  const key = readFileSync(join(root, 'public', keyFile), 'utf8').trim()
  if (`${key}.txt` !== keyFile) throw new Error('The IndexNow key file does not match its name')
  const sitemap = readFileSync(join(root, 'dist', 'client', 'sitemap.xml'), 'utf8')
  const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
  if (!urlList.length) throw new Error('The sitemap has no URLs')
  const keyLocation = `${SITE}/${keyFile}`
  const liveKey = await fetch(keyLocation)
  if (!liveKey.ok || (await liveKey.text()).trim() !== key) throw new Error('The IndexNow key file is not live yet')
  const response = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: new URL(SITE).host, key, keyLocation, urlList }),
  })
  if (!response.ok) throw new Error(`IndexNow returned ${response.status}: ${(await response.text()).slice(0, 300)}`)
  console.log(`IndexNow accepted ${urlList.length} URLs (${response.status}).`)
} catch (error) {
  console.warn(`IndexNow notification failed: ${error.message}`)
}
