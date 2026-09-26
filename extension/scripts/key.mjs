/**
 * The extension's signing key. The manifest carries the public key (vite.config.ts EXTENSION_KEY), which fixes
 * the extension ID that the ob.Pal Desktop helper allows (desktop/src/win/install.rs EXTENSION_IDS).
 * The private key lives outside the repository.
 *
 * Usage: node extension/scripts/key.mjs [path/to/private-key.pem]
 *   Prints the manifest `key` value and the extension ID for that private key, creating the key pair first
 *   when the file does not exist. Default path: ~/.obpal-keys/extension-key.pem.
 *   Publishing to the Chrome Web Store: on the first upload, include this private key as key.pem in the
 *   ZIP root so the store keeps the same ID; the store does not accept a manifest `key` otherwise.
 */
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const file = resolve(process.argv[2] || join(homedir(), '.obpal-keys', 'extension-key.pem'))
let pem
if (existsSync(file)) {
  pem = readFileSync(file, 'utf8')
} else {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, kp.privateKey, { mode: 0o600 })
  pem = kp.privateKey
  console.log(`created ${file}`)
}
const der = createPublicKey(pem).export({ type: 'spki', format: 'der' })
// Chrome's ID: the first 128 bits of SHA-256(public key DER), hex digits mapped onto a-p.
const id = createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)])
console.log(`key ${der.toString('base64')}`)
console.log(`id  ${id}`)
