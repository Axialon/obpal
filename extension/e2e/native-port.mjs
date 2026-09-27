/** Connect the test worker's Port API to the inert Node stub, without a native host registration or another port. */
import { spawn } from 'node:child_process'

export async function nativePort(worker, host, script) {
  const origin = `chrome-extension://${new URL(worker.url()).host}/`
  await worker.evaluate((host) => {
    const ports = new Map()
    const queue = []
    let serial = 0
    const event = () => {
      const listeners = new Set()
      return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), emit: (m) => { for (const fn of listeners) fn(m) } }
    }
    globalThis.__nativeStub = {
      drain: () => queue.splice(0),
      receive: (id, message) => ports.get(id)?.onMessage.emit(message),
      close: (id) => { const port = ports.get(id); ports.delete(id); port?.onDisconnect.emit(port) },
    }
    chrome.runtime.connectNative = (name) => {
      if (name !== host) throw new Error('Only the test native host is allowed')
      const id = ++serial
      const port = { name, onMessage: event(), onDisconnect: event(),
        postMessage: (message) => queue.push({ id, message }),
        disconnect: () => { ports.delete(id); queue.push({ id, close: true }) },
      }
      ports.set(id, port)
      return port
    }
  }, host)
  const children = new Map()
  let reading = false
  const timer = setInterval(async () => {
    if (reading) return
    reading = true
    try {
      for (const item of await worker.evaluate(() => globalThis.__nativeStub.drain())) {
        let child = children.get(item.id)
        if (item.close) { child?.stdin.end(); continue }
        if (!child) {
          child = spawn(process.execPath, [script, origin], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
          children.set(item.id, child)
          let buffer = Buffer.alloc(0)
          let replies = Promise.resolve()
          child.stdout.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk])
            while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
              const length = buffer.readUInt32LE(0)
              const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
              buffer = buffer.subarray(4 + length)
              replies = replies.then(() => worker.evaluate(([id, m]) => globalThis.__nativeStub.receive(id, m), [item.id, message])).catch(() => {})
            }
          })
          child.on('exit', () => { children.delete(item.id); void worker.evaluate((id) => globalThis.__nativeStub.close(id), item.id).catch(() => {}) })
          child.stdin.on('error', () => {})
        }
        const body = Buffer.from(JSON.stringify(item.message))
        const size = Buffer.alloc(4)
        size.writeUInt32LE(body.length)
        child.stdin.write(Buffer.concat([size, body]))
      }
    } catch { clearInterval(timer) } finally { reading = false }
  }, 20)
  return () => { clearInterval(timer); for (const child of children.values()) { child.stdin.end(); child.kill() } }
}
