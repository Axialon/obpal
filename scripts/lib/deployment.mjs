/** Shared destination validation for builds and operations. A fresh build stays on loopback. */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const LOCAL_ORIGIN = 'http://localhost:5175'

/** A linked lane must never acquire a new deployment entry point. Standalone clones and source archives work. */
export function guardDeployCheckout(root) {
  const git = join(root, '.git')
  if (existsSync(git) && !statSync(git).isDirectory()) throw new Error('Deploy from a standalone checkout, never a linked lane worktree')
}

export function publicOrigin(value, { required = false, https = false } = {}) {
  if (!value && required) throw new Error('Set OBPAL_PUBLIC_ORIGIN to the origin you operate')
  let url
  try { url = new URL(value || LOCAL_ORIGIN) } catch { throw new Error('not an origin: use an absolute http(s) origin') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (https && url.port)
    || (url.protocol !== 'https:' && (https || url.protocol !== 'http:' || !local))) {
    throw new Error('not an origin: use HTTPS, or HTTP on loopback for local development, without credentials or a path')
  }
  return url.origin
}

/** An explicit CLI origin wins; the old live-only variable remains supported when the shared one is absent. */
export function liveOrigin(value, env = {}) {
  return publicOrigin(value || env.OBPAL_PUBLIC_ORIGIN || env.OBPAL_LIVE_ORIGIN, { required: true })
}

/** Validate before starting the build or invoking Wrangler. Values never appear in errors. */
export function deploymentTarget(env = {}) {
  const origin = publicOrigin(env.OBPAL_PUBLIC_ORIGIN, { required: true, https: true })
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID to your deployment account')
  return { origin, accountId: env.CLOUDFLARE_ACCOUNT_ID }
}

/** Accept only an exact custom domain matching the build; fail before a deploy on extra or wildcard routes. */
export function guardDeployment(config, { origin, accountId }) {
  if (!config.name || config.name === 'my-controller') throw new Error('Choose your own Worker name in wrangler.jsonc')
  const routes = config.routes || []
  if (config.route || routes.length !== 1 || routes[0].custom_domain !== true || routes[0].pattern !== new URL(origin).hostname) {
    throw new Error('Configure exactly one custom domain in wrangler.jsonc matching OBPAL_PUBLIC_ORIGIN')
  }
  if (config.account_id && config.account_id !== accountId) throw new Error('Wrangler account differs from CLOUDFLARE_ACCOUNT_ID')
  if (config.workers_dev !== false) throw new Error('Disable workers_dev so deployment serves only the configured destination')
}

/** No repository or public commit identity is inherited from the upstream project. */
export function publicationTarget(env = {}) {
  const repository = env.OBPAL_PUBLIC_REPOSITORY || ''
  const authorName = env.OBPAL_SNAPSHOT_AUTHOR_NAME || ''
  const authorEmail = env.OBPAL_SNAPSHOT_AUTHOR_EMAIL || ''
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)) throw new Error('Set OBPAL_PUBLIC_REPOSITORY to your owner/repository')
  if (!authorName.trim() || /[\r\n\0]/.test(authorName) || !/^[A-Za-z0-9+_.-]+@users\.noreply\.github\.com$/.test(authorEmail)) {
    throw new Error('Set OBPAL_SNAPSHOT_AUTHOR_NAME and OBPAL_SNAPSHOT_AUTHOR_EMAIL to your public name and GitHub noreply address')
  }
  return { repository, authorName, authorEmail }
}

/** JSONC strings are preserved while comments and trailing commas are removed. */
export function parseJsonc(text) {
  return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match, quoted) => quoted || '')
    .replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (match, quoted, close) => quoted || close))
}
