import { describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library'
import { renderSVG } from 'uqr'
import { encodePairing, encodeLanPairing } from '@obpal/core'
import { luminance, parseColor } from '../packages/host/src/color'
import { brandedQr, plainQr, qrColors } from '../packages/host/src/qr'
import { rasterize } from './raster.mjs'

/** Pairing links as hosts make them: online (the usual), a local dev origin, and a direct LAN code (the longest). */
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed * 197 + ((i * i) >> 2)) & 255)
const LINKS = [
  `https://obpal.blackboxes.net/p/#${encodePairing({ secret: bytes(16, 1), fp: bytes(32, 2) })}`,
  `http://127.0.0.1:5179/p/#${encodePairing({ secret: bytes(16, 3), fp: bytes(32, 4) })}`,
  `https://obpal.blackboxes.net/p/#${encodeLanPairing({ id: bytes(16, 5), nonce: bytes(16, 6), ufrag: 'aB3d', pwd: 'wxgNMld8ocbrEDVaf6TJ7hM4', cands: [{ host: '6f1c2a4e-9b8d-4c3a-8e2f-1a2b3c4d5e6f.local', port: 51234 }, { host: '192.168.1.24', port: 51235 }] })}`,
]
const ACCENTS = ['#c6ff34', '#d2c3f6', '#99e1d9', '#b2d5e5', '#38bdf8', '#fb7185', '#fcd34d', '#7c3aed', '#ff5a1f', '#ffffff', '#ffff00', '#000000']
/** Page backgrounds around the plate: the site's night, Carbon, Violet, and the light surface. */
const SURFACES = ['#0a0718', '#171717', '#36255c', '#f4f6fb']
/** The pairing chip draws its code at 168 CSS px: 168 device px, or 336 on a 2x screen. */
const CHIP = [168, 336]

type Img = { data: Uint8ClampedArray; width: number; height: number }
/** Two independent decoders: jsQR, and ZXing's (the family most phone scanners descend from), neither trying harder. */
const DECODERS: Record<string, (img: Img) => string | null> = {
  jsQR: (img) => jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null,
  ZXing: (img) => {
    const lum = new Uint8ClampedArray(img.width * img.height)
    for (let i = 0; i < lum.length; i++) lum[i] = (img.data[i * 4] * 299 + img.data[i * 4 + 1] * 587 + img.data[i * 4 + 2] * 114) / 1000
    try { return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, img.width, img.height)))).getText() } catch { return null }
  },
}
const ALL = Object.keys(DECODERS)

/** Which decoders read the code, drawn at `size` px and set on a page background with room around it. */
async function readers(svg: string, size: number, text: string, opts: { background?: string; blur?: number } = {}): Promise<string[]> {
  const img = await rasterize(svg, size, { ...opts, pad: Math.round(size * 0.12) })
  return ALL.filter((name) => DECODERS[name](img) === text)
}

describe('the branded QR code scans', () => {
  it('with both decoders at the chip’s sizes, on every surface', async () => {
    for (const bg of SURFACES) for (const size of CHIP) expect(await readers(brandedQr(LINKS[0]), size, LINKS[0], { background: bg }), `${bg} at ${size}px`).toEqual(ALL)
  })

  it('in every accent, however light or dark', async () => {
    for (const accent of ACCENTS) for (const size of [168, 240]) expect(await readers(brandedQr(LINKS[0], { accent }), size, LINKS[0], { background: '#171717' }), `${accent} at ${size}px`).toEqual(ALL)
  })

  it('wherever uqr’s plain squares of the same density scan, from 140 to 320 px', async () => {
    // Both decoders miss a few exact scales even for plain squares; the brand must not add misses of its own. The
    // direct LAN code (a denser version 11) is shown plain by ob.Pal Link; branded, it still reads at 90% of scales.
    for (const link of LINKS) {
      const plain = renderSVG(link, { ecc: 'Q', border: 3 })
      const branded = brandedQr(link)
      const dense = link.length > 120
      const reads: Record<string, { branded: number; plain: number }> = Object.fromEntries(ALL.map((n) => [n, { branded: 0, plain: 0 }]))
      let sizes = 0
      for (let size = dense ? 180 : 140; size <= 320; size += 6) {
        sizes++
        const bg = size % 4 ? '#0a0718' : '#f4f6fb'
        for (const name of await readers(branded, size, link, { background: bg })) reads[name].branded++
        for (const name of await readers(plain, size, link, { background: bg })) reads[name].plain++
      }
      for (const name of ALL) {
        const r = reads[name]
        const why = `${name}, ${link.length} chars: branded ${r.branded}, plain ${r.plain} of ${sizes}`
        if (dense) expect(r.branded / sizes, why).toBeGreaterThanOrEqual(0.9)
        else expect(r.branded, why).toBeGreaterThanOrEqual(r.plain)
      }
    }
  }, 60_000)

  it('for a local link too, and at ECC H (denser, so bigger)', async () => {
    expect(await readers(brandedQr(LINKS[1], { accent: '#fb7185' }), 168, LINKS[1], { background: '#0a0718' })).toEqual(ALL)
    for (const link of LINKS.slice(0, 2)) expect(await readers(brandedQr(link, { ecc: 'H' }), 240, link, { background: '#f4f6fb' }), link).toEqual(ALL)
  })

  it('a little out of focus, as a camera sees a screen', async () => {
    for (const accent of ['#c6ff34', '#7c3aed']) expect(await readers(brandedQr(LINKS[0], { accent }), 240, LINKS[0], { background: '#171717', blur: 1.2 })).toEqual(ALL)
  })

  it('with pale ink, a dark plate and a pale accent asked for, which are corrected rather than obeyed', async () => {
    const svg = brandedQr(LINKS[0], { ink: '#9aa3ad', plate: '#2a2a2a', accent: '#fff8d0' })
    expect(await readers(svg, 168, LINKS[0], { background: '#171717' })).toEqual(ALL)
  })

  it('and so does the plain fallback', async () => {
    for (const bg of ['#171717', '#f4f6fb']) for (const size of [120, 168]) expect(await readers(plainQr(LINKS[0]), size, LINKS[0], { background: bg })).toEqual(ALL)
  })
})

describe('the QR colours', () => {
  it('keep dark parts dark and the plate light, whatever is asked for', () => {
    for (const accent of [...ACCENTS, 'rgb(250 250 240)', '250 250 240', 'hotpink', '']) {
      const c = qrColors({ accent, ink: '#eeeeee', plate: '#111111' })
      expect(luminance(parseColor(c.eye)!)).toBeLessThanOrEqual(0.04)
      expect(luminance(parseColor(c.ink)!)).toBeLessThanOrEqual(0.02)
      expect(luminance(parseColor(c.plate)!)).toBeGreaterThanOrEqual(0.85)
    }
  })
  it('keep a dark enough accent as it is, and the vivid accent for the mark', () => {
    expect(qrColors({ accent: '#1c1433' }).eye).toBe('#1c1433')
    expect(qrColors({ accent: '#c6ff34' }).accent).toBe('#c6ff34')
    expect(brandedQr(LINKS[0])).toContain('stroke="#c6ff34"')
  })
  it('label the code for screen readers only when asked', () => {
    expect(brandedQr(LINKS[0])).toContain('aria-hidden="true"')
    expect(brandedQr(LINKS[0], { label: 'Scan "me"' })).toContain('role="img" aria-label="Scan &#34;me&#34;"')
  })
})
