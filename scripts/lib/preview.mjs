/**
 * Link previews for the site's pages (Open Graph and Twitter), made from each page's own title and description so
 * they can't drift from them: the page's address on the site, and the site's one preview image (public/og.png,
 * rendered by scripts/og-image.mjs). vite.config.ts adds them to every page it builds, and a page without a
 * description of its own is described as the home page is; tests/messaging.test.ts checks them.
 */

/** Where the site is served, which previews always name (a link shared from anywhere points there). */
export const SITE = 'https://obpal.blackboxes.net'
/** The preview image, at the size the social sites draw a large card. */
export const PREVIEW_IMAGE = {
  path: '/og.png',
  width: 1200,
  height: 630,
  alt: 'The ob.Pal headline beside a phone held sideways as a gamepad, lit in lime.',
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" }
/** HTML text as the reader sees it (Vite escapes attribute values again as it writes them). */
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39|#x27);/g, (_, e) => ENTITIES[e]).trim()

/** A built page's address on the site: '/sim/index.html' (or '/sim/') is https://obpal.blackboxes.net/sim/. */
export function pageUrl(path, origin = SITE) {
  const p = `/${path.replace(/^\/+/, '')}`.replace(/index\.html$/, '')
  return new URL(p.endsWith('/') || p.endsWith('.html') ? p : `${p}/`, origin).href
}

/** A page's title and description as its source says them; `fallback` where it has no description. */
export function pageWords(html, fallback = '') {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]
  const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html)?.[1]
  return { title: decode(title ?? 'ob.Pal'), description: description ? decode(description) : fallback }
}

/**
 * The preview tags for one page, as Vite's tag descriptors (vite.config.ts pagePreviews). `path` is the page's file in
 * the build ('/sim/index.html'); `fallback`, the description for a page without one; `origin`, where the site is.
 */
export function previewTags(html, path, { fallback = '', origin = SITE } = {}) {
  const { title, description } = pageWords(html, fallback)
  const image = new URL(PREVIEW_IMAGE.path, origin).href
  const property = (name, content) => ({ tag: 'meta', attrs: { property: name, content }, injectTo: 'head' })
  const named = (name, content) => ({ tag: 'meta', attrs: { name, content }, injectTo: 'head' })
  return [
    property('og:type', 'website'),
    property('og:site_name', 'ob.Pal'),
    property('og:url', pageUrl(path, origin)),
    property('og:title', title),
    property('og:description', description),
    property('og:image', image),
    property('og:image:width', String(PREVIEW_IMAGE.width)),
    property('og:image:height', String(PREVIEW_IMAGE.height)),
    property('og:image:alt', PREVIEW_IMAGE.alt),
    named('twitter:card', 'summary_large_image'),
    named('twitter:title', title),
    named('twitter:description', description),
    named('twitter:image', image),
    named('twitter:image:alt', PREVIEW_IMAGE.alt),
  ]
}
