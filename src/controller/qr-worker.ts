/** The fallback QR reader. Frames arrive one at a time and never leave this worker. */
import jsQR from 'jsqr'

type QRFrame = { id: number; width: number; height: number; pixels: ArrayBuffer }
const worker = self as unknown as { onmessage: ((event: MessageEvent<QRFrame>) => void) | null; postMessage(value: { id: number; text: string | null; corners?: { x: number; y: number }[] }): void }

worker.onmessage = ({ data }) => {
  let text: string | null = null
  let corners: { x: number; y: number }[] | undefined
  try {
    if (Number.isInteger(data.width) && Number.isInteger(data.height) && data.width > 0 && data.height > 0 && data.width <= 720 && data.height <= 720 && data.pixels.byteLength === data.width * data.height * 4) {
      const code = jsQR(new Uint8ClampedArray(data.pixels), data.width, data.height, { inversionAttempts: 'attemptBoth' })
      text = code?.data ?? null
      if (code) corners = [code.location.topLeftCorner, code.location.topRightCorner, code.location.bottomRightCorner, code.location.bottomLeftCorner].map(p => ({ x: p.x / data.width, y: p.y / data.height }))
    }
  } catch { /* a malformed or incomplete frame is not a code */ }
  worker.postMessage({ id: data.id, text, ...(corners ? { corners } : {}) })
}
