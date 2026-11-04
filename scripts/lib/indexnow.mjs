import { publicOrigin } from './deployment.mjs'

/** Indexing is optional. Check only the operator's selected proof, against this local or live origin. */
export async function checkIndexNowProof({ origin, keyFile, fetcher = fetch }) {
  if (!keyFile) return false
  if (!/^[a-f0-9]{32}\.txt$/.test(keyFile)) throw new Error('Select your own IndexNow key file in public/')
  origin = publicOrigin(origin, { required: true })
  const response = await fetcher(`${origin}/${keyFile}`)
  if (!response.ok || (await response.text()).trim() !== keyFile.slice(0, -4)) throw new Error('The selected IndexNow proof is not served')
  return true
}

/** Every submitted URL and the operator's verification file must belong to the selected origin. */
export function indexNowPayload({ origin, keyFile, key, sitemap }) {
  origin = publicOrigin(origin, { required: true, https: true })
  if (!/^[a-f0-9]{32}\.txt$/.test(keyFile) || `${key}.txt` !== keyFile) throw new Error('Use your own IndexNow key file in public/')
  const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1])
  if (!urlList.length) throw new Error('The sitemap has no URLs')
  if (urlList.some(value => { const url = new URL(value); return url.origin !== origin || url.username || url.password })) {
    throw new Error('Rebuild the sitemap with the selected OBPAL_PUBLIC_ORIGIN before indexing')
  }
  return { host: new URL(origin).host, key, keyLocation: `${origin}/${keyFile}`, urlList }
}

/** No requests at all without --submit. Injected fetch keeps regression fixtures offline. */
export async function submitIndexNow(payload, { submit = false, fetcher = fetch } = {}) {
  if (!submit) return { submitted: false, count: payload.urlList.length }
  const liveKey = await fetcher(payload.keyLocation)
  if (!liveKey.ok || (await liveKey.text()).trim() !== payload.key) throw new Error('The IndexNow key file is not live at the selected origin')
  const response = await fetcher('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`IndexNow returned ${response.status}`)
  return { submitted: true, count: payload.urlList.length }
}
