/**
 * What a device or host keeps between sessions, in IndexedDB: its own DTLS certificate (so its fingerprint is
 * stable and the other side can pin it) and the pairings it remembers. Everything degrades to "this session
 * only" where storage is unavailable (private mode, storage denied, a browser that can't store certificates).
 */
import { certFingerprint } from './pairing'

const DB = 'obpal'
const VERSION = 1
const CERT_TTL = 365 * 24 * 3600 * 1000
/** Renew a certificate this close to its expiry, so a pairing never breaks mid-week. */
const CERT_RENEW = 7 * 24 * 3600 * 1000

/** A remembered pairing: the other side's identity and the key both sides share. */
export interface StoredPair {
  /** Pairing id, base64url (16 bytes). */
  id: string
  /** 32-byte pairing key, minted by the host and sent to the phone inside the DTLS-protected channel. */
  key: Uint8Array
  /** The other side's DTLS fingerprint (32 bytes). */
  peerFp: Uint8Array
  peerName: string
  /** Last time the two connected, epoch ms. */
  at: number
}

const memory = { certs: new Map<string, RTCCertificate>(), pairs: new Map<string, StoredPair>() }
let dbPromise: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('certs')) db.createObjectStore('certs')
        if (!db.objectStoreNames.contains('pairs')) db.createObjectStore('pairs', { keyPath: 'id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function tx<T>(store: 'certs' | 'pairs', mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then((db) => {
    if (!db) return undefined
    return new Promise<T | undefined>((resolve) => {
      try {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(undefined)
        t.onabort = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  })
}

/** This side's persistent certificate (generated on first use, renewed a week before it expires) and its fingerprint. */
export async function loadCertificate(role: 'device' | 'host'): Promise<{ cert: RTCCertificate; fp: Uint8Array; fresh: boolean }> {
  const stored = memory.certs.get(role) ?? (await tx<RTCCertificate>('certs', 'readonly', (s) => s.get(role)))
  if (stored && typeof stored.expires === 'number' && stored.expires - Date.now() > CERT_RENEW) {
    try {
      const fp = await certFingerprint(stored)
      memory.certs.set(role, stored)
      return { cert: stored, fp, fresh: false }
    } catch { /* unusable: regenerate */ }
  }
  const cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256', expires: CERT_TTL } as EcKeyGenParams)
  memory.certs.set(role, cert)
  await tx('certs', 'readwrite', (s) => s.put(cert, role))
  return { cert, fp: await certFingerprint(cert), fresh: true }
}

export async function listPairs(): Promise<StoredPair[]> {
  const rows = (await tx<StoredPair[]>('pairs', 'readonly', (s) => s.getAll())) ?? [...memory.pairs.values()]
  return rows.filter(isPair).sort((a, b) => b.at - a.at)
}

export async function getPair(id: string): Promise<StoredPair | null> {
  const row = (await tx<StoredPair>('pairs', 'readonly', (s) => s.get(id))) ?? memory.pairs.get(id)
  return row && isPair(row) ? row : null
}

export async function findPairByPeer(fp: Uint8Array): Promise<StoredPair | null> {
  return (await listPairs()).find((p) => p.peerFp.length === fp.length && p.peerFp.every((b, i) => b === fp[i])) ?? null
}

export async function putPair(p: StoredPair): Promise<void> {
  memory.pairs.set(p.id, p)
  await tx('pairs', 'readwrite', (s) => s.put(p))
}

export async function forgetPair(id: string): Promise<void> {
  memory.pairs.delete(id)
  await tx('pairs', 'readwrite', (s) => s.delete(id))
}

export async function forgetAllPairs(): Promise<void> {
  memory.pairs.clear()
  await tx('pairs', 'readwrite', (s) => s.clear())
}

function isPair(x: unknown): x is StoredPair {
  const p = x as StoredPair
  return !!p && typeof p === 'object' && typeof p.id === 'string' && p.key instanceof Uint8Array && p.key.length === 32 &&
    p.peerFp instanceof Uint8Array && p.peerFp.length === 32 && typeof p.peerName === 'string' && typeof p.at === 'number'
}
