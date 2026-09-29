# @obpal/core

The ob.Pal protocol, for hosts and devices alike: the STATE, PAD, POINTER and POSE codecs, pairing and its HMAC binding, room signaling, the direct LAN code, the control catalogue (utilities, routes, profiles and controllers) and the device-side link.

Most pages want [`@obpal/host`](https://github.com/Axialon/obpal/tree/main/packages/host#readme), or one tag:

```html
<script type="module" src="https://obpal.blackboxes.net/embed.js"></script>
<obpal-remote app="My scene" modes="face.trackpad face.wii"></obpal-remote>
```

Use this package directly to speak the protocol yourself: a native bridge, a device of your own, or tools around the catalogue.

```ts
import { checkProfile, CONTROLLERS, withControllers, type Layout } from '@obpal/core'

// A layout that names controllers, filled in for every phone: modes [point, tilt, hold].
const layout: Layout = withControllers({ v: 1, tray: [], controllers: ['face.wii', 'face.trackpad'] })

// What each controller is (name, category, utilities, modes).
console.log(CONTROLLERS['face.wii'].for)

// Check a controller profile someone wrote, by the catalogue's rules.
const { profile, errors } = checkProfile(JSON.parse(profileJson))
```

- Protocol: [spec/PROTOCOL.md](https://github.com/Axialon/obpal/blob/main/spec/PROTOCOL.md)
- Catalogue: [spec/CATALOGUE.md](https://github.com/Axialon/obpal/blob/main/spec/CATALOGUE.md), and as data at https://obpal.blackboxes.net/catalogue.json

## Install

```bash
npm install @obpal/core
```

ES modules with type declarations. Entry points: `@obpal/core`, and `@obpal/core/toss` for the toss detector alone. [CHANGELOG.md](https://github.com/Axialon/obpal/blob/main/packages/core/CHANGELOG.md) lists what changed in each release.

## License

MIT
