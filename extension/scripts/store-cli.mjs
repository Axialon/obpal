#!/usr/bin/env node
/** Repository-local review server and explicit dashboard bookkeeping commands. */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artwork, checkStore, formatStatus, latestGithubRelease, readJson, recordSubmission, storeStatus, validatePackage } from './store-manager.mjs'
import { renderStoreKit, writeStoreKit } from './store-kit.mjs'
import { checkStoreCopy } from './store-copy.mjs'

export function kitHandler(root, options) {
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return }
      const path = new URL(request.url, 'http://localhost').pathname
      if (path === '/') { response.writeHead(302, { Location: '/extension/release/store-kit.html' }); response.end(); return }
      let body, type
      if (path === '/extension/release/store-kit.html') {
        // Browser proofs render without writing into the checkout; normal serving prepares the kit too.
        body = (await (options?.renderOnly ? renderStoreKit(root, { ...options, preparing: true }) : writeStoreKit(root, options))).html; type = 'text/html; charset=utf-8'
      } else if (artwork.some(([file]) => path === `/extension/store/${file}`)) {
        // Revalidate on image requests too. No other repository files are served.
        await checkStore(root)
        body = readFileSync(join(root, path.slice(1))); type = 'image/png'
      } else if (path === `/extension/release/obpal-link-${readJson(join(root, 'extension/package.json')).version}-store.zip`) {
        const pack = validatePackage(root)
        body = readFileSync(pack.path); type = 'application/zip'
        response.setHeader('Content-Disposition', `attachment; filename="${pack.file}"`)
      } else { response.writeHead(404); response.end('Not found'); return }
      response.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' })
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch (error) {
      response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(`Kit unavailable: ${error.message}`)
    }
  }
}

export async function serveKit(root, port, options) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('serve requires a port argument')
  const server = createServer(kitHandler(root, options))
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok) })
  return server
}

export async function main(root, args) {
  const [command, version, reason] = args.filter(arg => arg !== '--')
  const count = args.filter(arg => arg !== '--').length
  if (['status', 'kit', 'check'].includes(command) && count !== 1 || ['serve', 'submitted', 'published'].includes(command) && count !== 2 || command === 'rejected' && count !== 3) throw new Error('Unexpected arguments')
  if (command === 'status') {
    let release
    try { release = await latestGithubRelease() } catch (error) { console.error(error.message) }
    console.log(formatStatus(await storeStatus(root, release)))
  } else if (command === 'kit') {
    const result = await writeStoreKit(root)
    console.log(`Store kit ${result.version}: ${result.out}\n${result.changedFields} changed fields; ${result.changedImages} changed images`)
  } else if (command === 'check') {
    const { development } = await checkStore(root); checkStoreCopy(root)
    console.log(development ? `Store status, copy and ledger agree; ${readJson(join(root, 'extension/package.json')).version} is in development, so its art and zip are held to their receipts once it is prepared (pnpm run store -- kit)` : 'Store listing, art, status, copy and ledger agree')
  } else if (command === 'serve') {
    const port = Number(version), server = await serveKit(root, port)
    console.log(`Live store kit: http://127.0.0.1:${port}/extension/release/store-kit.html (Ctrl+C to stop)`)
    const stop = () => { server.close(); server.closeAllConnections() }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    await new Promise(ok => server.once('close', ok))
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  } else if (['submitted', 'published', 'rejected'].includes(command)) {
    await recordSubmission(root, command, version, reason)
    console.log(`Store ${version}: ${command}; commit extension/store/submissions.json and status.json`)
  } else throw new Error('Usage: pnpm run store -- status | kit | serve <port> | check | submitted <version> | published <version> | rejected <version> "<reason>"')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(resolve(import.meta.dirname, '../..'), process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
