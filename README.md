# ob-pal

Turn any phone into a remote for 3D and on-screen navigation. Scan a QR code and your phone steers the screen: turn it to rotate objects, point to aim, swipe to orbit. There's nothing to install on the phone or the screen.

**Live:** https://obpal.blackboxes.net. Open [/view](https://obpal.blackboxes.net/view/) on a computer, then scan the code with your phone.

## How it works

```
Phone (HTTPS web app)  ──WebRTC DataChannels──▶  Host (web page with @obpal/host, later a native bridge)
        │                                              │
        └──── Cloudflare Worker + Durable Object (pairing / signaling only) ────┘
```

- **Phone** (`/p`): reads the W3C motion sensors and runs a multi-touch trackpad and host-defined button trays. It streams a 76-byte state packet at 60 Hz over an unreliable DataChannel and sends buttons over a reliable one.
- **Pairing:** the QR carries a 128-bit secret and the host's DTLS certificate fingerprint, in the URL fragment so it never reaches a server. The phone checks that the host's certificate matches the QR fingerprint. It then proves it knows the secret with an HMAC bound to both certificates. The signaling server only sees a hash of the secret.
- **Host SDK** (`packages/host`): `Remote.create()`, `mountPairing(el)`, and `consume()` once per frame, which returns interpolated rotation, pointer, orbit, pan, zoom and twist.

See [PLAN.md](PLAN.md) for the architecture, compatibility matrix and roadmap, and [spec/PROTOCOL.md](spec/PROTOCOL.md) for the wire protocol.

## Use it in your own page

```js
import { Remote, Mode } from '@obpal/host'

const remote = await Remote.create({
  appName: 'My Viewer',
  layout: { v: 1, modes: [Mode.hold, Mode.point], tray: [{ id: 'reset', label: 'Reset' }] },
})
remote.mountPairing(document.getElementById('pair'))
remote.on('button', ({ id }) => { if (id === 'reset') resetView() })

function frame(now) {
  const f = remote.consume(now)
  if (f.clutch) applyRotation(f.qRel) // phone rotation since grab, in view space
  orbit(f.pad1); pan(f.pad2); zoom(f.zoom)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
```

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:5175 (Vite + Worker + Durable Object)
pnpm test         # protocol math, codec and pairing tests
pnpm run deploy   # test, build, deploy to obpal.blackboxes.net
```

Phones need HTTPS to get motion sensors. To test on a real phone, deploy, or run a Cloudflare Tunnel to the dev server.

Optional TURN relay, for guest Wi-Fi, cellular and corporate networks: set the `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` secrets using a Cloudflare Realtime TURN key.

## Layout

| Path | What |
|---|---|
| `packages/core` | Protocol: quaternion math, state codec, pairing, signaling, device-side link |
| `packages/host` | Host SDK for any web page |
| `src/controller` | Phone controller app |
| `src/viewer` | Hosted 3D viewer (three.js + camera-controls) |
| `worker` | Cloudflare Worker: static assets, `/r/:room` signaling, `/api/ice` |
| `spec` | Open protocol spec |

MIT licensed.

## Demo assets

The viewer catalogue includes brand models: Club V Crew insignia (CVC, CC, K9C, MMC) and Blackboxes ecosystem models (engine cores and Box'em matrices), under `public/models/`. They are © their respective owners and are **not** covered by the MIT license; they're included only to demonstrate the viewer.

## License

The code is MIT licensed; see [LICENSE](LICENSE). The Club V Crew insignia and wordmark models in `public/models/cvc` are brand assets and aren't covered by it; see [their notice](public/models/cvc/NOTICE.md).

Contact: [hello@obpal.blackboxes.net](mailto:hello@obpal.blackboxes.net)
