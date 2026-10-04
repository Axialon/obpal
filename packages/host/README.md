# @obpal/host

Pair a phone with any web page and read it as a controller: 1:1 rotation, a trackpad, Wii-style pointing, a gamepad, 3D from the phone's own sensors, and the phone's keyboard. The phone needs no app. It scans a QR code, its browser becomes the controller, and phone and page talk peer to peer over WebRTC.

- Live demo: https://obpal.blackboxes.net/embed/
- Protocol: [spec/PROTOCOL.md](https://github.com/Axialon/obpal/blob/main/spec/PROTOCOL.md). Controllers, profiles and shared scenes: [spec/CATALOGUE.md](https://github.com/Axialon/obpal/blob/main/spec/CATALOGUE.md).
- For AI agents: https://obpal.blackboxes.net/llms.txt and https://obpal.blackboxes.net/catalogue.json.

## One tag, no build step

```html
<script type="module" src="https://obpal.blackboxes.net/embed.js"></script>
<obpal-remote app="My scene" seats="4" modes="face.trackpad face.wii"></obpal-remote>
```

The element shows a "Scan to control" chip in a corner. A phone that scans it joins the page, and the page reads it each frame (below). The element:
- draws only in its shadow root, so the page's CSS doesn't reach it and it adds nothing to the page's styles;
- needs no inline scripts or styles, so it works under a strict Content Security Policy: `script-src https://obpal.blackboxes.net; connect-src https://obpal.blackboxes.net wss://obpal.blackboxes.net`;
- loads 2.3 kB up front, and the rest (the SDK, about 19 kB gzip, then the QR code) on the first sign of a person;
- can appear several times on one page, each with its own code.

## Install

```bash
npm install @obpal/host
```

ES modules with type declarations; npm also installs [`@obpal/core`](https://www.npmjs.com/package/@obpal/core), which it depends on. Entry points: `@obpal/host` (the SDK), `@obpal/host/element` (`defineObpalRemote`), `@obpal/host/gamepad` (`installGamepadShim`) and `@obpal/host/qr` (the QR codes). [CHANGELOG.md](https://github.com/Axialon/obpal/blob/main/packages/host/CHANGELOG.md) lists what changed in each release.

## The element, typed

```ts
import { defineObpalRemote, type ObpalRemote } from '@obpal/host/element'
import type { Frame } from '@obpal/host'

defineObpalRemote() // once; the hosted embed.js does this for you
const pal: ObpalRemote = document.querySelector('obpal-remote')!

// What phones may take over. Each phone holds one node at a time, picked from its scene list (seats > 1).
pal.setScene({ nodes: [{ id: 'cube', name: 'Cube', kind: 'object' }] })
// Buttons in the phone's tray.
pal.layout = { tray: [{ id: 'reset', label: 'Reset', icon: 'reset' }] }

pal.addEventListener('obpal-join', (e) => {
  const { name, controller } = e.detail.participant
  console.log(`${name} joined, using ${controller ?? 'a phone'}`)
  // Hand the newcomer the cube if it's free.
  if (!pal.holder('cube')) pal.setScene({ held: { ...pal.held, cube: e.detail.participant.id } })
})
pal.addEventListener('obpal-button', (e) => {
  if (e.detail.id === 'reset') resetCube()
})

function loop(now: number) {
  for (const p of pal.participants) {
    const f: Frame = pal.frame(now, p.id) // deltas since the last call for this participant
    if (pal.holding(p.id) !== 'cube') continue
    cube.position.x += f.pad1[0] * 0.01 // a one-finger drag, in CSS px on the phone
    cube.position.y -= f.pad1[1] * 0.01
    cube.scale.multiplyScalar(2 ** f.zoom) // a pinch
    if (f.clutch) turnCube(f.qRel) // the gyro on: the phone's rotation since it went on, in view space
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
```

**Attributes**

| Attribute | Default | What |
|---|---|---|
| `app` | the page title | The name the phone shows |
| `modes` | `tilt hold point` | What the phone offers, in order; the first opens on it. Mode names (`point`, `hold`, `tilt`, `pad`, `gamepad`, `track`) and controller ids (below) |
| `seats` | `1` | 1: a new phone takes over. Up to 8: a shared scene, each phone holding its own node |
| `profile` | | A catalogue profile to suggest (`flight`, `driving`, `shooter`, `pointer`, …) |
| `corner` | `bottom-right` | `bottom-left`, `top-right`, `top-left`, or `inline` where the element is |
| `accent` | | A CSS colour for the chip |
| `open` | | Show the code at once; it reflects whether the chip is open |
| `label` | `Scan to control` | The chip's words |
| `scheme` | `auto` | `light` or `dark` chip |
| `code` | on | `false` hides the short code beside the QR code |
| `test-link` | off | Adds "Open on this device", to try it without a phone |
| `service` | where embed.js came from | The room service |

**Controllers** (`modes` and `layout.controllers`; catalogue §9.1): `face.gamepad`, `face.wheel` (the gamepad with the Driving profile), `face.wii` (point, A and B), `face.mouse` (point, Left, Right and a wheel), `face.trackpad` (drag, pinch, twist, and the gyro 1:1 or tilt), `face.hand` (3D: what you hold moves with the phone), `face.keyboard` (the phone's keyboard). Phones that predate them get the matching modes.

**Events** (they bubble; `detail.participant` is `{ id, name, color, lead, caps, controller, profile }`)

| Event | detail |
|---|---|
| `obpal-connect` | `{ name, caps }`: a phone connected to an empty scene |
| `obpal-join`, `obpal-leave` | `{ participant }`; what a leaver held is free |
| `obpal-button` | `{ id, ev }`: tray buttons, trackpad taps (`pad`), the Wii face (`wii-a`, `wii-b`, `wii-plus`, `wii-minus`), the key row (`key-Enter`, …) |
| `obpal-mode` | `{ mode, controller, profile }`: a phone switched controller |
| `obpal-claim` | `{ node }` (null lets go): cancel it to refuse, or to keep the claims yourself with `setScene({ held })` |
| `obpal-status` | `{ status, reason? }`: `idle`, `starting`, `ready`, `connecting`, `connected`, `offline`, `unsupported` (no WebRTC, or not https) or `error` |
| `obpal-disconnect`, `obpal-text`, `obpal-value`, `obpal-toss`, `obpal-recenter`, `obpal-pad` | As the Remote's events of those names |

**Properties and methods:** `frame(now, who?)`, `participants`, `setScene({ nodes?, held? })`, `holder(node)`, `holding(who)`, `held`, `layout`, `open`, `status`, `pairingUrl`, `ready` (a promise of the `Remote`, or null where the browser can't host a phone; awaiting it starts the remote now), `remote`, `start()`.

**Frame** (`frame()` and `Remote.consume()`): `qRel` and `clutch` (1:1 rotation while the gyro is on), `tilt` (a stick from tilting), `pad1`, `pad2`, `zoom`, `twist` (trackpad gestures since the last frame), `aim` (Wii-style pointing), `pose` (3D, while a thumb is on the pad: `p`, `q`, `tracked`, `touching`, `gen` and `source`, which says whether the pose comes from the phone's `camera`, a `model` estimated from its motion, an `unknown` phone or the host's `glow` camera), `hand`, `body`, `touching`, `mode`, `connected`.

Without the element, from the hosted script: `const remote = await window.obpal.remote({ appName: 'My scene' })`.

## Hand and body

Hand and body tracking use the phone's camera. Read them from the same frame as other input:

```ts
const frame = pal.frame(performance.now())
if (frame.hand?.tracked) {
  const wrist = frame.hand.landmarks[0] // 21 hand landmarks; frame.hand.gen changes when tracking reacquires
}
if (frame.body?.tracked) {
  const leftShoulder = frame.body.landmarks[11] // 33 body landmarks, with visibility and presence scores
}
```

Either field is null when no packet arrived or its last packet is at least 250 ms old; check `tracked` before using landmarks. The phone performs camera-based body tracking locally. See the [HAND packet](https://github.com/Axialon/obpal/blob/main/spec/PROTOCOL.md#hand-packet-type-6-a-camera-tracked-hand) and [BODY protocol notes](https://github.com/Axialon/obpal/blob/main/docs/PROTOCOL.md#body-packet-type-7-a-camera-tracked-body) for coordinates and freshness rules.

## The SDK

```ts
import { Controller, PairingChip, Remote } from '@obpal/host'

const remote = await Remote.create({
  appName: 'My viewer',
  layout: { v: 1, controllers: [Controller.trackpad, Controller.wii], tray: [{ id: 'reset', label: 'Reset' }] },
})
new PairingChip({ remote })
remote.on('button', ({ id }) => { if (id === 'reset') resetView() })
remote.on('mode', (mode, who) => console.log(`${who.name} uses ${who.controller}`))

requestAnimationFrame(function frame(now) {
  const f = remote.consume(now)
  if (f.clutch) applyRotation(f.qRel)
  orbit(f.pad1)
  requestAnimationFrame(frame)
})
```

- Shared scenes: `Remote.create({ …, seats: 8 })`, `remote.setScene({ nodes, held })`, and `Claims` for one participant per node.
- `remote.padOf(id)` is a standard gamepad; `installGamepadShim` shows it to Gamepad API code.
- `withControllers(layout)` is what the SDK does to every layout it sends: it fills in `modes` (and the mouse face, the keyboard, the wheel's profile) from `controllers`, for phones that predate them.

## The pairing chip

`PairingChip` is the pairing UI: a small chip in a corner of the page (the ob.Pal mark, "Scan to control" and a status dot). It opens to show the QR code and the short code. When a phone comes in it shows the connection seal, and folds by itself about nine seconds after the seal appears, eight after it settles (it holds while a pointer or focus is on it, the comparison is open, or another phone is being added), so it never stays over the page. A connected card also has its own close, closes on Escape from anywhere on the page, and on a press outside it. It takes on the page's look.

```ts
const chip = new PairingChip({
  remote,                    // required: the Remote it pairs
  corner: 'bottom-right',    // 'bottom-right' (default) | 'bottom-left' | 'top-right' | 'top-left' | 'inline'
  variant: 'chip',           // 'chip' (default) | 'panel': the card's contents alone, always shown, in parent's frame
  accent: '#ff5a1f',         // any CSS colour; default: the page's own accent (below), else ob.Pal lime
  open: false,               // start open
  label: 'Scan to control',  // the closed chip's words
  parent: document.body,     // where chip.el goes: an element or a shadow root (default document.body)
  offset: '16px',            // distance from the corner, for the four corners
  scheme: 'auto',            // 'auto' (from the page) | 'light' | 'dark'
  code: true,                // show the short code beside the QR
  testLink: false,           // a link that opens the controller on this device
  avoid: '#settings, .sheet', // the page's own panels the card must never cover (below)
  onToggle: (open) => {},    // it opened or closed
})

chip.el          // the chip's element (its own shadow root, so page CSS can't break it)
chip.expanded    // whether it is open
chip.expand()    // open it: QR, short code, status (once the page's panels are out of its way)
chip.collapse()  // close it
chip.toggle()    // as a click on the chip
chip.refresh()   // read the page's look again (after a theme change it couldn't see)
chip.destroy()   // remove it, and stop asking for a short code
```

`'inline'` leaves placement to the page: the chip sits where `parent` puts it. The four corners fix it to the viewport. `--obpal-offset` (or `--obpal-offset-x` and `--obpal-offset-y`) moves it from its corner, from the page's own CSS; ob.Pal's sims lift it above their bottom panel on phones that way. `--obpal-qr` sets the QR code's size in the card (default `168px`), for a short screen.

**Sharing the corner with the page's panels.** The card opens above the chip, over whatever is there. `avoid` names the page's own panels and sheets (a settings panel, a menu, a sheet): while one of them is shown where the card opens, the card folds to the chip, a mouse resting on the chip doesn't open it, and once they're out of the way it opens again if it was open. A click on the chip still opens it (a page that closes its panel on that click gives the card its place back). The chip only ever takes the pointer where it draws, so the page stays clickable where the card would open. Keep the panels themselves clear of the chip: end them above it (`--obpal-offset` plus 44px and a gap), or move the chip with `--obpal-offset*`.

`variant: 'panel'` is for a page that gives pairing a place of its own (ob.Pal's home page does, in its hero): the QR code as wide as `parent`, the short code and the status under it, no chip and no frame of its own, and it stays open.

**The page's look.** Unless the options say otherwise, the chip reads these from where it sits, again whenever the page's theme changes:

| What | From |
|---|---|
| Accent | `--obpal-accent`, else `--accent`, `--primary`, `--color-primary` or `--brand` (a colour or an `R G B` triplet) |
| Font | the inherited `font-family`, or `--obpal-font` |
| Light or dark | `color-scheme`, else the page background's brightness |
| Corner radius | `--obpal-radius`, else `--radius` or `--border-radius` (clamped to 6–28 px) |

**Keyboard and screen readers.** The chip is a button (`aria-expanded`); Enter or Space opens and closes it, Escape closes it and keeps the focus on it (once a phone is connected, Escape closes it from anywhere on the page, unless something else took the key). The QR is an image with a label, the code is read digit by digit, and the status is a polite live region. It opens on hover only with a mouse, and moves without animation under `prefers-reduced-motion`.

**Strict pages.** The chip builds everything from elements (no `innerHTML`, `insertAdjacentHTML` or `DOMParser`) and styles itself with one constructed stylesheet, so it works under a Content Security Policy without `'unsafe-inline'` and where the page enforces Trusted Types (`require-trusted-types-for 'script'`).

## The short code

Beside the QR code the chip shows a short code, ten digits (`482 193 7056`), to type on the phone at `obpal.blackboxes.net/p`: for a TV or a headset, or a phone across the room. A code works once and for ten minutes at most; the chip shows a new one after each use. The room service never learns enough to use it: the last five digits never leave the two devices (PROTOCOL §2b). Under heavy use the service may ask the screen for a moment's proof of work before a new code; the Remote does it by itself.

The chip asks for codes itself. Without it:

```ts
const release = remote.wantCode()   // keep a code live while something shows it
remote.on('code', () => show(remote.code, remote.codeSite)) // '4821937056', 'obpal.blackboxes.net/p'
release()                           // nothing shows it any more
```

`Remote.create({ …, shortCode: false })` turns codes off.

## QR codes

```ts
import { brandedQr, brandedQrElement, plainQr, plainQrElement } from '@obpal/host/qr'

brandedQr(remote.pairingUrl, { accent: '#ff5a1f' })        // SVG markup: round dots, rounded eyes, the mark in the middle
brandedQrElement(remote.pairingUrl, { accent: '#ff5a1f' }) // the same as an <svg> element (no markup parsed)
plainQr(remote.pairingUrl)                                 // plain squares, the fallback (plainQrElement as an element)
```

The branded code is ECC Q, dark modules on a light plate, and it darkens an accent until the eyes read nearly as dark as the ink, so every camera reads it. tests/qr.test.ts reads it back with jsQR and ZXing over sizes, surfaces, twelve accents and blur, and requires it to read wherever uqr's plain squares of the same density read. Keep it at 2.5 px a module or more (the chip draws a pairing link's code at 168 px); ECC H wants 3.5.

## The older card

`remote.mountPairing(el, { variant: 'compact' | 'full' })` still renders the earlier pairing card (plain QR, no short code) into an element of the page.

**Developing your page on localhost:** the SDK takes a localhost page for ob.Pal's own development server and pairs through it. While you develop locally, pass `service: 'https://obpal.blackboxes.net'` to `Remote.create`, or to `defineObpalRemote({ service })` for the element. The hosted embed.js always pairs through the site it came from.

## License

MIT
