import { pageUrl, SITE } from './preview.mjs'

export const AI_SIGNALS = 'search=yes, ai-input=yes, ai-train=yes'
export const INDEXABLE_PAGES = ['/', '/view/', '/sim/', '/sim/arm/', '/sim/arena/', '/sim/humanoid/', '/embed/', '/link/', '/catalogue/', '/buttons/', '/sponsor/', '/donate/', '/privacy/', '/trust/']

export const simUrl = (card) => card.href?.startsWith('/sim/device/') ? `/sim/${card.id}/` : card.href ? new URL(card.href, SITE).pathname : null
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const jsonLd = (value) => JSON.stringify(value).replace(/</g, '\\u003c')

export function robotsTxt() {
  return `User-agent: *\nAllow: /\n\nContent-Signal: ${AI_SIGNALS}\nSitemap: ${SITE}/sitemap.xml\n`
}

export function sitemapXml(cards, modified = () => '2026-09-28') {
  const paths = [...new Set([...INDEXABLE_PAGES, ...cards.map(simUrl).filter(Boolean)])]
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map(path => `  <url><loc>${escapeHtml(pageUrl(path))}</loc><lastmod>${modified(path)}</lastmod></url>`).join('\n')}\n</urlset>\n`
}

const alternateName = ['obpal', 'ob pal', 'OB Pal', 'obPal']
const linkStore = 'https://chromewebstore.google.com/detail/obpal-link/jnnpcnoilofjaffabnhecfokjjknlemg'
const sameAs = ['https://github.com/Axialon/obpal', 'https://github.com/Axialon/obpal-link', linkStore, 'https://www.npmjs.com/package/@obpal/host', 'https://www.npmjs.com/package/@obpal/core']
const organization = { '@type': 'Organization', '@id': `${SITE}/#blackboxes`, name: 'Blackboxes', alternateName, sameAs, url: 'https://blackboxes.net/' }
const website = { '@type': 'WebSite', '@id': `${SITE}/#website`, name: 'ob.Pal', alternateName, sameAs, url: `${SITE}/`, publisher: { '@id': organization['@id'] } }
const software = (name, url, description, platform) => ({ '@type': 'SoftwareApplication', name, url, description, applicationCategory: 'MultimediaApplication', operatingSystem: platform, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } })
export const FAQ = [
  { question: 'How do I pair my phone with ob.Pal?', answer: 'Open a sim or the viewer on a screen, then scan its QR code with your phone or type its short code. The controller opens in your phone browser.' },
  { question: 'What do I need to use ob.Pal?', answer: 'A phone with a browser and a second screen for the viewer or sims. The phone needs no app or account. ob.Pal Link is an optional browser extension; ob.Pal Desktop is an optional Windows helper.' },
  { question: 'How does ob.Pal handle privacy?', answer: 'The service introduces paired devices. Control traffic is encrypted over WebRTC, and ob.Pal requires no account and uses no analytics.' },
]
export const faqMarkup = () => `<section class="home-faq" aria-labelledby="faq-h"><h2 id="faq-h">Questions about ob.Pal</h2>${FAQ.map(({ question, answer }) => `<article><h3>${escapeHtml(question)}</h3><p>${escapeHtml(answer)}</p></article>`).join('')}</section>`

export function structuredData(path, cards) {
  const canonical = pageUrl(path)
  const card = path === '/sim/arm/' ? null : cards.find(c => simUrl(c) === path)
  const crumbs = [{ '@type': 'ListItem', position: 1, name: 'ob.Pal', item: `${SITE}/` }]
  if (path.startsWith('/sim/') || card) crumbs.push({ '@type': 'ListItem', position: 2, name: 'Sims', item: `${SITE}/sim/` })
  if (card && path !== '/sim/') crumbs.push({ '@type': 'ListItem', position: 3, name: card.name, item: canonical })
  else if (path !== '/' && path !== '/sim/') crumbs.push({ '@type': 'ListItem', position: crumbs.length + 1, name: path === '/sim/arm/' ? 'Robot arms' : path.split('/').filter(Boolean).at(-1), item: canonical })
  const graph = [organization, website, { '@type': 'BreadcrumbList', itemListElement: crumbs }]
  if (path === '/' || path === '/link/') {
    if (path === '/') graph.push({ ...software('ob.Pal', `${SITE}/`, 'Use your phone as a controller for 3D scenes, games, robot sims and more in a browser.', 'Web browser'), alternateName, sameAs })
    graph.push(
      { ...software('ob.Pal Link', `${SITE}/link/`, 'Browser extension that lets your phone control websites as a gamepad, 3D mouse or keyboard.', 'Chrome'), installUrl: linkStore },
      software('ob.Pal Desktop', `${SITE}/link/`, 'Optional Windows helper for controlling the PC mouse and keyboard with a phone.', 'Windows'),
    )
    if (path === '/') graph.push({ '@type': 'FAQPage', mainEntity: FAQ.map(({ question, answer }) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })) })
  }
  if (path === '/sim/') graph.push({ '@type': 'ItemList', name: 'ob.Pal sims', itemListElement: cards.filter(c => c.href).map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, url: pageUrl(simUrl(c)) })) })
  if (path === '/sim/arm/') graph.push({ '@type': 'ItemList', name: 'Robot arm sims', itemListElement: cards.filter(c => c.id.startsWith('arm-')).map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, url: canonical })) })
  if (card && path !== '/sim/') graph.push({ '@type': 'ItemList', name: 'ob.Pal sim', itemListElement: [{ '@type': 'ListItem', position: 1, name: card.name, url: canonical }] })
  return { '@context': 'https://schema.org', '@graph': graph }
}

export function catalogueMarkup(cards, controllerName) {
  return `<section id="seo-list" class="seo-list" aria-label="All sims"><h2>All phone-controlled sims</h2><ul>${cards.filter(c => c.href).map(c => `<li><h3><a href="${escapeHtml(c.href.startsWith('/sim/device/') ? simUrl(c) : c.href)}">${escapeHtml(c.name)}</a></h3><p>${escapeHtml(c.kind)} · ${escapeHtml(c.blurb)}</p><p>Controllers: ${c.controllers.map(controllerName).map(escapeHtml).join(', ')}</p></li>`).join('')}</ul></section>`
}

/**
 * The static page of one device (/sim/<id>/), made from the device page. `models` are the URLs of the meshes the device
 * loads: each is named in a preload, so the browser starts the download while it reads the page.
 */
export function deviceMarkup(html, card, controllerName, models = []) {
  const path = simUrl(card)
  const title = `${card.name} sim · ob.Pal`
  const description = `${card.blurb} Control it with your phone in ob.Pal.`
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${escapeHtml(description)}" />`)
    .replace(/<link rel="canonical" href="[^"]*"\s*\/>/, `<link rel="canonical" href="${pageUrl(path)}" />`)
    .replace(/<meta name="robots" content="noindex, follow"\s*\/>/, '')
    .replace(/(<h1 id="dev-name">)[^<]*(<\/h1>)/, `$1${escapeHtml(card.name)}$2`)
    .replace(/(<p class="eyebrow" id="dev-kind">)[^<]*(<\/p>)/, `$1${escapeHtml(card.kind)}$2`)
    .replace('<p class="sim-lede" id="dev-blurb"></p>', `<p class="sim-lede" id="dev-blurb">${escapeHtml(card.blurb)}</p>`)
    .replace('<div class="dev-faces" id="dev-faces" role="group" aria-label="Controllers that suit it"></div>', `<div class="dev-faces" id="dev-faces" role="group" aria-label="Controllers that suit it"></div><section class="seo-device" id="seo-device"><h2>Control this sim with your phone</h2><p>${escapeHtml(card.teaches ?? card.blurb)}</p><ul>${card.controllers.map(id => `<li><strong>${escapeHtml(controllerName(id))}:</strong> ${escapeHtml(card.how?.[id] ?? 'Control the sim from your phone')}</li>`).join('')}</ul><p><a href="/sim/">Explore all phone-controlled sims</a></p></section>`)
  out = out.replace('</head>', `    <script type="application/ld+json">${jsonLd(structuredData(path, [card]))}</script>\n  </head>`)
  // As a fetch, in the mode the page's own request has (the same origin, no credentials beyond it), so that request finds
  // it; ahead of the page's scripts, so it is asked for first.
  const preloads = models.map(url => `<link rel="preload" href="${escapeHtml(url)}" as="fetch" crossorigin fetchpriority="low" />\n    `).join('')
  const before = out.search(/<link rel="modulepreload"|<script type="module"/), at = before >= 0 ? before : out.indexOf('</head>')
  if (preloads && at >= 0) out = out.slice(0, at) + preloads + out.slice(at)
  for (const key of ['og:url', 'og:title', 'og:description', 'twitter:title', 'twitter:description']) {
    const content = key.endsWith('url') ? pageUrl(path) : key.endsWith('title') ? title : description
    out = out.replace(new RegExp(`(<meta (?:property|name)="${key}" content=")[^"]*`), `$1${escapeHtml(content)}`)
  }
  return out
}
