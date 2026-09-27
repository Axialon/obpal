/**
 * Content Security Policy violations, from every page an end-to-end suite opens: importing this module makes each
 * browser context the suite creates through Playwright's `chromium` (launch().newContext(), launch().newPage(),
 * launchPersistentContext()) listen for `securitypolicyviolation` from the first script on, and `cspCheck` fails
 * if any came. The pages' policies are enforced (vite.config.ts), so a violation is something that broke.
 */
import { chromium } from 'playwright'

/** Every violation seen: which page, the directive it broke, and what was blocked where. */
export const cspViolations = []
const TAG = '[csp-violation] '

function listen() {
  document.addEventListener('securitypolicyviolation', (e) => {
    console.error(`[csp-violation] ${JSON.stringify({ page: location.pathname, directive: e.effectiveDirective, blocked: e.blockedURI, at: `${e.sourceFile}:${e.lineNumber}`, sample: e.sample })}`)
  })
}

async function watch(ctx) {
  await ctx.addInitScript(listen)
  ctx.on('console', (m) => { if (m.text().startsWith(TAG)) cspViolations.push(JSON.parse(m.text().slice(TAG.length))) })
  return ctx
}

const launch = chromium.launch.bind(chromium)
chromium.launch = async (...args) => {
  const browser = await launch(...args)
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async (...o) => watch(await newContext(...o))
  // A page of its own context, as browser.newPage() makes it, but watched.
  browser.newPage = async (...o) => (await browser.newContext(...o)).newPage()
  return browser
}
const persistent = chromium.launchPersistentContext.bind(chromium)
chromium.launchPersistentContext = async (...args) => watch(await persistent(...args))

/** For a suite's check(): the violations, if any, as the error; otherwise how many were watched (none). */
export async function cspCheck() {
  if (cspViolations.length) throw new Error(`${cspViolations.length}: ${cspViolations.slice(0, 3).map((v) => JSON.stringify(v)).join(' | ')}`)
  return 'none on any page'
}
