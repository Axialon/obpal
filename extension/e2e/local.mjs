/**
 * A local stand-in for obpal.blackboxes.net, for the end-to-end tests and the benches: an HTTPS server (a throwaway
 * self-signed cert made in ./tls on first run, never committed; the browsers run with --ignore-certificate-errors)
 * that serves the site build (dist/client: the controller page, its assets, the service worker) and proxies the
 * room service (/r/* WebSockets and /api/*) to this checkout's own worker, a fresh one per run
 * (scripts/local-worker.mjs), so both ends under test are the code here.
 *
 * Production is used only when asked for: OBPAL_E2E_UPSTREAM=https://obpal.blackboxes.net, or an explicit
 * `upstream` (the benches that measure it). Its per-address limits are shared by every run on this machine, so
 * tests that lean on it fail under each other's load.
 *
 * setOffline(true) makes the service unreachable (proxied requests refused, sockets closed) without touching the
 * static files, so the phone can be taken "off the internet" while the page itself still loads from the cache.
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer, request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWorker } from '../../scripts/local-worker.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
export const UPSTREAM = 'obpal.blackboxes.net'
export const LOCAL_PORT = 5176
/** The local worker's port when OBPAL_E2E_WORKER_PORT names none. */
export const LOCAL_WORKER_PORT = 5189
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.txt': 'text/plain',
}

/** The stand-in's certificate: made with openssl the first time (the *.pem files are gitignored). */
async function ensureCert() {
  const dir = join(here, 'tls'), cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem')
  if (!existsSync(cert) || !existsSync(key)) {
    await mkdir(dir, { recursive: true })
    const args = ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '3650',
      '-subj', '/CN=ob.Pal e2e local', '-addext', `subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:${UPSTREAM}`, '-keyout', key, '-out', cert]
    try {
      execFileSync('openssl', args, { stdio: 'ignore' })
    } catch {
      throw new Error(`The e2e stand-in needs a throwaway TLS certificate; install openssl or run:
  openssl ${args.map((a) => (/[\s:,/=]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
    }
  }
  return Promise.all([readFile(cert), readFile(key)])
}

/**
 * `port`: OBPAL_E2E_PORT, else 5176, so a run can sit beside another. `upstream` (or OBPAL_E2E_UPSTREAM): the room
 * service to proxy to, http or https. Without either, a fresh local worker is started here on OBPAL_E2E_WORKER_PORT
 * (else 5189) and stopped by close() (or when the process exits).
 * The result's `serviceArgs` are the Chromium flags that send a browser's requests for the service's own host (the
 * extension calls it by name) to this stand-in instead of production; none when production is the upstream.
 */
export async function startLocal({ dist = resolve(here, '../../dist/client'), port = Number(process.env.OBPAL_E2E_PORT) || LOCAL_PORT, upstream = process.env.OBPAL_E2E_UPSTREAM || '' } = {}) {
  const worker = upstream ? null : await startWorker({ port: Number(process.env.OBPAL_E2E_WORKER_PORT) || LOCAL_WORKER_PORT })
  if (worker) upstream = worker.origin
  const target = new URL(upstream)
  const secure = target.protocol === 'https:'
  const targetPort = Number(target.port) || (secure ? 443 : 80)
  let cert, key
  try { [cert, key] = await ensureCert() } catch (error) { await worker?.close(); throw error }
  let offline = false
  let sockets = new Set()

  async function serveFile(pathname, res) {
    let file = normalize(join(dist, pathname))
    if (!file.startsWith(normalize(dist))) { res.writeHead(403); return res.end() }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
    } catch {
      if (!extname(file)) file += '/index.html'
    }
    try {
      const body = await readFile(file)
      const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=60' }
      res.writeHead(200, headers)
      res.end(body)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    }
  }

  const server = createServer({ cert, key }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://local')
    if (url.pathname.startsWith('/api/')) {
      if (offline) { res.writeHead(503); return res.end() }
      // The stand-in plays the service's own origin: a page it serves calls the API same-origin, as it would there.
      const origin = req.headers.origin === `https://127.0.0.1:${port}` ? { origin: target.origin } : {}
      const up = (secure ? httpsRequest : httpRequest)({ host: target.hostname, port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: target.host, ...origin } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      })
      up.on('error', () => {
        if (res.headersSent || res.writableEnded || res.destroyed) { res.destroy(); return }
        res.writeHead(502); res.end()
      })
      req.pipe(up)
      return
    }
    void serveFile(decodeURIComponent(url.pathname), res)
  })
  // WebSocket rooms: splice the TLS client socket to the upstream at the byte level once the upgrade request is rewritten.
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/r/') || offline) { socket.destroy(); return }
    const opened = () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}`)
      }
      up.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length) up.write(head)
      socket.pipe(up).pipe(socket)
    }
    const up = secure ? tlsConnect({ host: target.hostname, port: targetPort, servername: target.hostname }, opened) : netConnect({ host: target.hostname, port: targetPort }, opened)
    sockets.add(socket)
    const drop = () => { sockets.delete(socket); socket.destroy(); up.destroy() }
    up.on('error', drop)
    socket.on('error', drop)
    socket.on('close', () => sockets.delete(socket))
  })
  try {
    await new Promise((r, j) => { server.once('error', j); server.listen(port, '127.0.0.1', r) })
  } catch (e) {
    await worker?.close()
    throw e
  }
  return {
    origin: `https://127.0.0.1:${port}`,
    /** Where the room service is: this run's own worker, or what was asked for. */
    upstream: target.origin,
    serviceArgs: target.origin === `https://${UPSTREAM}` ? [] : [`--host-resolver-rules=MAP ${UPSTREAM} 127.0.0.1:${port}`, '--ignore-certificate-errors'],
    /** Refuse the room service (and drop live sockets) or bring it back. */
    setOffline(v) {
      offline = v
      if (v) for (const s of sockets) s.destroy()
    },
    close: async () => {
      await new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) })
      await worker?.close()
    },
  }
}
