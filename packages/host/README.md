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

Not published yet. When it is:

```bash
npm install @obpal/host
```

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

**Controllers** (`modes` and `layout.controllers`; catalogue §9.1): `face.gamepad`, `face.wheel` (the gamepad with the Driving profile), `face.wii` (point, A and B), `face.mouse` (point, Left, Right and a wheel), `face.trackpad` (drag, pinch, twist, and the gyro 1:1 or tilt), `face.hand` (3D: what you hold follows your hand), `face.keyboard` (the phone's keyboard). Phones that predate them get the matching modes.

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

**Frame** (`frame()` and `Remote.consume()`): `qRel` and `clutch` (1:1 rotation while the gyro is on), `tilt` (a stick from tilting), `pad1`, `pad2`, `zoom`, `twist` (trackpad gestures since the last frame), `aim` (Wii-style pointing), `pose` (3D, while a thumb is on the pad), `touching`, `mode`, `connected`.

Without the element, from the hosted script: `const remote = await window.obpal.remote({ appName: 'My scene' })`.

## The SDK

```ts
import { Controller, Remote } from '@obpal/host'

const remote = await Remote.create({
  appName: 'My viewer',
  layout: { v: 1, controllers: [Controller.trackpad, Controller.wii], tray: [{ id: 'reset', label: 'Reset' }] },
})
remote.mountPairing(document.getElementById('pair')!, { variant: 'compact' })
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

**Developing your page on localhost:** the SDK takes a localhost page for ob.Pal's own development server and pairs through it. While you develop locally, pass `service: 'https://obpal.blackboxes.net'` to `Remote.create`, or to `defineObpalRemote({ service })` for the element. The hosted embed.js always pairs through the site it came from.

## License

MIT
