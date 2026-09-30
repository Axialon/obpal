# ob.Pal

Your phone is the controller: robots, drones, games, music and your computer, with friends. Scan a code and it opens in your phone's browser. No app, no account.

- **Sims:** over 40 at [/sim](https://obpal.blackboxes.net/sim/), from robot arms and drones to a music studio.
- **Together:** up to eight phones in one scene.
- **Controllers:** gamepad, wheel, trackpad, pointer, air mouse, 3D hand, keyboard, drums and keys ([spec/CATALOGUE.md](spec/CATALOGUE.md)), and the buttons of a headset, clicker or Bluetooth pad.
- **Websites:** [Add ob.Pal Link from the Chrome Web Store](https://chromewebstore.google.com/detail/obpal-link/jnnpcnoilofjaffabnhecfokjjknlemg), a browser extension that gives a page a gamepad (for games that read the Gamepad API), a 3D mouse or keys. Tested in Chrome, Edge, Brave and Vivaldi; see [manual install](extension/README.md#manual-install-unpacked) and [the limits](extension/README.md#limitations). With ob.Pal Desktop (Windows only, macOS coming soon), the whole PC.
- **Your own page:** one tag, `<obpal-remote>`, or the host SDK ([below](#use-it-in-your-own-page)).
- **Private and open:** encrypted, no accounts; the code is MIT licensed.

**Live:** https://obpal.blackboxes.net. Open [/view](https://obpal.blackboxes.net/view/) or a [sim](https://obpal.blackboxes.net/sim/) on a computer, then scan the code with your phone.

[Check the source and connection seal](https://obpal.blackboxes.net/trust/): verify the domain or download channel, then compare the seal on both devices, especially after typing a code. The seal is a short comparison aid, not proof that a build is legitimate.

## How it works

```
Phone (HTTPS web app)  ──WebRTC DataChannels──▶  Host (web page with @obpal/host, later a native bridge)
        │                                              │
        └──── Cloudflare Worker + Durable Object (pairing / signaling only) ────┘
```

- **Phone** (`/p`): reads the W3C motion sensors and runs a multi-touch trackpad and host-defined button trays. It streams a 76-byte state packet at 60 Hz over an unreliable DataChannel and sends buttons over a reliable one.
- **Pairing:** the QR carries a 128-bit secret and the host's DTLS certificate fingerprint, in the URL fragment so it never reaches a server. The phone checks that the host's certificate matches the QR fingerprint. It then proves it knows the secret with an HMAC bound to both certificates. The signaling server only sees a hash of the secret.
- **No internet:** the controller page works offline after one visit (service worker), and a phone that paired once with the ob.Pal Link extension can reconnect over the LAN through a direct code, with no server at all, if the network lets devices reach each other (see [spec/PROTOCOL.md §2a](spec/PROTOCOL.md) and [the limits](extension/README.md#limitations)).
- **Host SDK** (`packages/host`): `Remote.create()`, `new PairingChip({ remote })` (the QR code and a short code to type, in a corner, in the page's look), and `consume()` once per frame, which returns interpolated rotation, pointer, orbit, pan, zoom and twist.
- **Short code:** beside the QR code, ten digits to type at obpal.blackboxes.net/p. The service keeps only the first five; the last five are the secret of a PAKE the two devices run over their DTLS channel, one attempt per code (see [spec/PROTOCOL.md §2b](spec/PROTOCOL.md)).

See [PLAN.md](PLAN.md) for the architecture, compatibility matrix and roadmap, and [spec/PROTOCOL.md](spec/PROTOCOL.md) for the wire protocol.

## Use it in your own page

One tag, no build step ([demo](https://obpal.blackboxes.net/embed/); attributes, events and a typed example in [packages/host/README.md](packages/host/README.md)):

```html
<script type="module" src="https://obpal.blackboxes.net/embed.js"></script>
<obpal-remote app="My scene" seats="4" modes="face.trackpad face.wii"></obpal-remote>
```

Or the SDK itself, from npm ([`@obpal/host`](https://www.npmjs.com/package/@obpal/host); it brings [`@obpal/core`](https://www.npmjs.com/package/@obpal/core)):

```bash
npm install @obpal/host
```

```js
import { Remote, Mode, PairingChip } from '@obpal/host'

const remote = await Remote.create({
  appName: 'My Viewer',
  layout: { v: 1, modes: [Mode.hold, Mode.point], tray: [{ id: 'reset', label: 'Reset' }] },
})
new PairingChip({ remote }) // the QR code and the short code, in a corner
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
pnpm run check    # typecheck + tests
pnpm run e2e:all  # every end-to-end suite against a local worker, one table (-- phone shared for some)
pnpm run deploy   # test, build, deploy to obpal.blackboxes.net
pnpm run check:live  # after a deploy: pages, pairing code, API rules, TURN, security headers, and that /link/ shows the release it downloads (-- --origin for yours)
```

Working with Claude Code agents: `.claude/README.md` lists the lane agent, the skills, the guard hook and the merge tool.

Phones need HTTPS to get motion sensors. To test on a real phone, deploy, or run a Cloudflare Tunnel to the dev server.

Optional TURN relay, for guest Wi-Fi, cellular and corporate networks: set the `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` secrets using a Cloudflare Realtime TURN key.

The embed: `pnpm build` writes `/embed.js` and its lazy part (`/assets/embed/`) beside the site; `pnpm e2e:embed` tests it end to end (the /embed/ demo, another site under a strict CSP, no WebRTC).

npm: `@obpal/core` and `@obpal/host` are on npm, and each has a CHANGELOG.md. `pnpm build:packages` builds `packages/core/dist` and `packages/host/dist` (ES modules, type declarations and the licence; `pnpm pack` does it first). `pnpm run publish:npm` is the release: a dry run that builds, tests, packs and inspects both tarballs and prints what it would publish; `pnpm run publish:npm -- --yes` publishes from the main checkout, on master, with a clean tree. npm asks the publisher to approve a sign-in link in a browser, and the script then checks the registry and installs the package in a temp folder.

## Layout

| Path | What |
|---|---|
| `packages/core` | Protocol: quaternion math, state codec, pairing, signaling, device-side link |
| `packages/host` | Host SDK for any web page, and the `<obpal-remote>` element (`/embed.js`) |
| `src/controller` | Phone controller app |
| `src/viewer` | Hosted 3D viewer (three.js + camera-controls) |
| `worker` | Cloudflare Worker: static assets, `/r/:room` signaling, `/api/ice` |
| `spec` | Open protocol spec |

MIT licensed.

## Demo assets

The viewer catalogue includes brand models: Club V Crew insignia (CVC, CC, K9C, MMC) and Blackboxes ecosystem models (engine cores and Box'em matrices), under `public/models/`. They are © their respective owners and are **not** covered by the MIT license; they're included only to demonstrate the viewer.

## License

The code is MIT licensed; see [LICENSE](LICENSE). The ob.Pal name and logo have a separate [draft fork naming policy](TRADEMARKS.md). The Club V Crew insignia and wordmark models in `public/models/cvc` are brand assets and aren't covered by it; see [their notice](public/models/cvc/NOTICE.md).

Contact: [hello@obpal.blackboxes.net](mailto:hello@obpal.blackboxes.net)
