/** Public destinations checked afresh before the upload kit is rendered. */
export const ITEM_ID = 'jnnpcnoilofjaffabnhecfokjjknlemg'
export const storeLinks = [
  ['Developer Dashboard', 'https://chrome.google.com/webstore/devconsole'],
  ['Store listing', `https://chromewebstore.google.com/detail/obpal-link/${ITEM_ID}`],
  ['Link page', 'https://obpal.blackboxes.net/link/'],
  ['Privacy', 'https://obpal.blackboxes.net/privacy/'],
  ['Trust', 'https://obpal.blackboxes.net/trust/'],
  ['Controller test', 'https://obpal.blackboxes.net/link/try/'],
  ['3D test', 'https://obpal.blackboxes.net/view/'],
]

export async function validateLiveLinks(links = storeLinks, request = fetch) {
  return Promise.all(links.map(async ([label, url]) => {
    let response
    try { response = await request(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' }) }
    catch { throw new Error(`Live link unavailable: ${label} (${url}); retry kit generation`) }
    await response.body?.cancel()
    if (response.status !== 200) throw new Error(`Live link ${label} returned HTTP ${response.status}: ${url}`)
    // Do not retain sign-in redirect query strings in evidence or HTML.
    return { label, url, status: response.status }
  }))
}
