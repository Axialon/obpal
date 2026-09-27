/**
 * The pure parts of the live check (scripts/check-live.mjs): which pages it loads, and what the site's headers,
 * security.txt and the Viewer's code must look like. Each check is a row: { check, status: 'pass' | 'FAIL' | 'WARN', detail }.
 */

/** Every page of the site, loaded at a desktop and a phone width. */
export const PAGES = ['/', '/view/', '/p/', '/buttons/', '/embed/', '/catalogue/', '/link/', '/privacy/', '/sim/', '/sim/arm/', '/sim/arena/']
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
