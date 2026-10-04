/**
 * The pure parts of the live check (scripts/check-live.mjs): which pages it loads, what the site's headers,
 * security.txt and the Viewer's code must look like, and whether the version /link/ shows is the release it downloads.
 * Each check is a row: { check, status: 'pass' | 'FAIL' | 'WARN', detail }.
 */

/** Every page of the site, loaded at a desktop and a phone width. */
export const PAGES = [
  '/', '/p/', '/view/', '/buttons/', '/embed/', '/catalogue/', '/link/', '/link/desktop/', '/link/try/', '/sponsor/', '/donate/', '/privacy/', '/trust/',
  '/sim/', '/sim/arm/', '/sim/arena/', '/sim/humanoid/', '/sim/device/', '/sim/octopus/',
]
export const VIEWPORTS = [[1440, 900], [390, 844]]

const row = (check, ok, detail, warn = false) => ({ check, status: ok ? (warn ? 'WARN' : 'pass') : 'FAIL', detail })
const cut = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The headers every page carries (public/_headers): HSTS for a year, the shared CSP (no framing by other sites),
 * COOP, a Permissions-Policy that turns off what no page uses, nosniff, a referrer policy and X-Frame-Options.
 * @param {(name: string) => string | null | undefined} get a response's header, by lower-case name
 */
export function pageHeaderChecks(get) {
  const h = (name) => get(name) ?? ''
  const hsts = h('strict-transport-security')
  const age = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0)
  const csp = h('content-security-policy')
  const pp = h('permissions-policy')
  const features = pp ? pp.split(',').length : 0
  return [
    row('HSTS', age >= 31_536_000, hsts ? `max-age ${Math.round(age / 86_400)} days${/includesubdomains/i.test(hsts) ? ', includeSubDomains' : ''}` : 'missing'),
    row('CSP', /frame-ancestors/i.test(csp), csp ? cut(csp) : 'missing'),
    row('COOP', h('cross-origin-opener-policy') === 'same-origin', h('cross-origin-opener-policy') || 'missing'),
    row('Permissions-Policy', /\bmicrophone=\(\)/.test(pp), pp ? `${features} features, microphone off` : 'missing'),
    row('X-Content-Type-Options', h('x-content-type-options').toLowerCase() === 'nosniff', h('x-content-type-options') || 'missing'),
    row('Referrer-Policy', !!h('referrer-policy'), h('referrer-policy') || 'missing'),
    row('X-Frame-Options', /^(sameorigin|deny)$/i.test(h('x-frame-options')), h('x-frame-options') || 'missing'),
  ]
}

/**
 * /.well-known/security.txt (RFC 9116): served, with a Contact and an Expires still ahead. Under 30 days left warns.
 * @param {number} status
 * @param {string} text
 * @param {number} now ms since the epoch
 */
export function securityTxtCheck(status, text, now) {
  if (status !== 200) return row('security.txt', false, `HTTP ${status}`)
  const contact = /^Contact:\s*\S+/im.test(text)
  const expires = Date.parse(/^Expires:\s*(\S+)/im.exec(text)?.[1] ?? '')
  if (!contact || Number.isNaN(expires)) return row('security.txt', false, `${contact ? '' : 'no Contact '}${Number.isNaN(expires) ? 'no Expires' : ''}`.trim())
  const days = Math.floor((expires - now) / 86_400_000)
  if (days < 0) return row('security.txt', false, `expired ${-days} days ago`)
  return row('security.txt', true, `Contact, expires in ${days} days`, days < 30)
}

/** The pairing code the Viewer shows (3 3 4 digits), masked: the check proves one is there without printing it. */
export function shownCode(text) {
  const m = /\b\d{3}\s\d{3}\s\d{4}\b/.exec(text)
  return m ? m[0].replace(/\d/g, '#') : null
}

/**
 * What /api/ice and the relay-only test say, without a credential: TURN offered to the host and to this check, how
 * many relay URLs of which kind, and whether a DataChannel forced through the relay opened and echoed.
 * @param {{ hostTurn: boolean[], check: { turn: boolean, urls: string[], creds: boolean } | null, relay: { opened: boolean, openMs?: number, echoMs?: number, localType?: string, relayProtocol?: string } | null }} r
 */
export function turnChecks({ hostTurn, check, relay }) {
  if (!check) return [row('TURN offered', false, 'the Viewer made no /api/ice request')]
  const kinds = [...new Set(check.urls.filter((u) => /^turns?:/.test(u)).map((u) => `${u.split(':')[0]}/${/transport=(\w+)/.exec(u)?.[1] ?? 'udp'}`))]
  return [
    row('TURN offered', check.turn && check.creds && hostTurn.includes(true), `host ${hostTurn.includes(true) ? 'yes' : 'no'}; check ${check.turn ? 'yes' : 'no'}; ${kinds.join(', ') || 'no relay URLs'}`),
    relay?.opened
      ? row('relay-only DataChannel', relay.localType === 'relay', `opened in ${relay.openMs} ms, echo ${relay.echoMs} ms, ${relay.localType ?? '?'}/${relay.relayProtocol ?? '?'}`)
      : row('relay-only DataChannel', false, relay ? 'did not open in 15 s' : 'not tried'),
  ]
}

/** The public repo whose latest release the /link/ buttons download. */
export const LINK_REPO = 'Axialon/obpal-link'
export const LINK_STORE = 'https://chromewebstore.google.com/detail/obpal-link/jnnpcnoilofjaffabnhecfokjjknlemg'
export const LINK_ZIP = `https://github.com/${LINK_REPO}/releases/latest/download/obpal-link.zip`

/** The page offers both the store install and the manual release zip. */
export function linkInstallChecks(html) {
  return [
    row('/link/ store', html.includes(`href="${LINK_STORE}"`), 'Chrome Web Store listing'),
    row('/link/ zip', html.includes(`href="${LINK_ZIP}"`), 'manual release zip'),
  ]
}

/** The files a Link release carries (.claude/skills/release/reference.md): the extension under two names, and the helper. */
export const RELEASE_ASSETS = (version) => ['obpal-link.zip', `obpal-link-${version}.zip`, 'obpal-desktop-windows-x64.zip']

/**
 * The version /link/ shows ("ob.Pal Link · 1.7.0 · free, …", or the older "Version 1.6.1 · free, …"), or null. The
 * build writes it from extension/package.json (vite.config.ts), while the download is GitHub's latest release, so the
 * two can differ.
 */
export function linkVersionLabel(html) {
  return /\b(?:Version|ob\.Pal Link\s+·)\s+(\d+\.\d+\.\d+)\b/.exec(html)?.[1] ?? null
}

/**
 * The tag and the file names in GitHub's answer for a repo's latest release (GET /repos/<repo>/releases/latest), or
 * null when it isn't one.
 * @returns {{ tag: string, assets: string[] } | null}
 */
export function latestRelease(json) {
  const tag = json?.tag_name
  if (typeof tag !== 'string' || !Array.isArray(json.assets)) return null
  return { tag, assets: json.assets.map((a) => String(a?.name)) }
}

/**
 * Release truth: /link/ names a version, and its download buttons fetch the latest release. The label must be that
 * release's tag, and the release must carry all its files. Without a release there is nothing to compare.
 * @param {{ label: string | null, release: { tag: string, assets: string[] } | null, http?: number }} r the label /link/ shows,
 *   the latest release, and the status GitHub answered with (named when there is no release)
 */
export function releaseChecks({ label, release, http }) {
  if (!release) return [row('latest release', false, `GitHub gave no release${http ? ` (HTTP ${http})` : ''}`)]
  const version = release.tag.replace(/^v/, '')
  const wanted = RELEASE_ASSETS(version)
  const missing = wanted.filter((name) => !release.assets.includes(name))
  return [
    row('latest release', true, `${release.tag}, ${release.assets.length} files`),
    row('/link/ label', label === version, label ? `shows ${label}, latest release is ${release.tag}` : 'no version on the page'),
    row('release files', !missing.length, missing.length ? `missing ${missing.join(', ')}` : `all ${wanted.length} present`),
  ]
}
