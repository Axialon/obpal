# ob.Pal Link

A Chromium (Manifest V3) extension that lets a phone paired through ob.Pal control any website:

- **Controller**: a virtual gamepad for Gamepad API games.
- **3D**: drag, pan and zoom for 3D viewers.
- **Keys**: keyboard and mouse input for keyboard games.

It works in Chrome, Edge, Brave, Opera, Vivaldi and Arc (Chromium 120 or later). The phone needs no app: it opens the ob.Pal controller in its browser.

## Install (unpacked)

```sh
pnpm install
pnpm run build:extension   # writes extension/dist
```

1. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
   - Opera: `opera://extensions`
   - Vivaldi: `vivaldi://extensions`
   - Arc: `arc://extensions`
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select `extension/dist`.
4. Pin **ob.Pal Link** to the toolbar.

After a rebuild, click the reload icon on the extension's card.

## Pair and play

1. Open the game or 3D page, then click the ob.Pal Link toolbar icon.
2. Scan the QR code with the phone's camera. The ob.Pal controller opens in the phone's browser and the status changes to **Connected**.
3. Turn on **This tab**.
4. Pick what the phone drives: **Controller**, **3D** or **Keys**. You can also switch from the phone, with the **Target** picker in its tray.

**Controlling tabs**
- One tab is controlled at a time. Turning on another tab moves control to it.
- A dot on the toolbar icon marks the controlled tab. The dot is lime while the phone is connected.

**How long the pairing lasts**
- The pairing stays up until the browser closes, or until you press × in the popup.
- To reconnect after that, scan the code again.

## Modes

### Controller (Gamepad API)

- `navigator.getGamepads()` includes `ob.Pal Controller (STANDARD GAMEPAD …)`, which uses the standard mapping.
- `gamepadconnected` and `gamepaddisconnected` fire.
- It works both for games that poll `getGamepads()` every frame and for games that wait for the connect event.
- As with a real controller in Chrome, the pad appears on its first button press after the page has loaded. By then, a game's `gamepadconnected` listener is registered.
- Physical controllers keep their slots. The virtual pad takes the first free slot.
- `vibrationActuator.playEffect('dual-rumble', …)` vibrates the phone. Each effect is clamped to 5 s and rate-limited.
- The phone must be in its **Gamepad** mode.

The shim is `installGamepadShim()` from `@obpal/host`, bundled into the page script.

### 3D viewer

The target is the largest visible `<canvas>` or `<model-viewer>`. If there is none, it is the element under the centre of the viewport. Each event goes to the element a real mouse would hit at that point, including overlays and the inside of open shadow roots.

| Phone input | Page receives |
|---|---|
| One-finger trackpad, Point-mode gyro, right stick, tilt | left-button drag (rotate) |
| Two-finger drag, left stick | right-button drag (pan) |
| Pinch, RT (in) / LT (out) | wheel events (zoom) |

**Event sequence**
1. `pointerdown` and `mousedown` at the target's centre.
2. `pointermove` and `mousemove`, carrying `buttons` and `movementX`/`movementY`.
3. `pointerup` and `mouseup` after 120 ms without input.

**Details**
- The `pointerId` is 1, the id of Chrome's real mouse. Page code that calls `setPointerCapture(e.pointerId)`, such as three.js OrbitControls, keeps working.
- When the virtual cursor reaches the target's edge, it lifts and re-grabs at the centre.
- Small wheel amounts are batched.

### Keys

| Phone input | Keyboard / mouse |
|---|---|
| Left stick (or tilt) | W A S D. Pressed at 0.4, released below 0.3 (hysteresis). |
| D-pad | Arrow keys |
| A / B / X / Y | Space / Escape / E / Q |
| Menu | Enter |
| LB / RB | Shift / Control |
| Right stick, Point-mode gyro, trackpad | mouse movement (`movementX`/`movementY`) |
| RT / LT | left / right mouse button (the left one also fires `click`) |

**Key events**
- Each key sends `keydown` and `keyup`, plus `keypress` for character keys.
- Events carry the correct `key`, `code`, `location` and legacy `keyCode`/`which`.
- They go to the focused element (or `body`) and bubble on to `document` and `window`, as real keys do.

**Mouse**
- Under pointer lock, only `movementX`/`movementY` matter.
- Otherwise, a small lime dot shows where the virtual mouse is.

### Changing the mappings

The mappings are typed config objects:
- Key bindings, thresholds and mouse speed: `DEFAULT_KEYS` in `src/shared/keys.ts`. To make another key bindable, add a row to the `KEYS` table there.
- 3D gains, rates and the pan style (`'right'` or `'shift'` drag): `DEFAULT_VIEWER` in `src/shared/viewer.ts`.

### Motion: Aim, Steer and Point (the control catalogue)

In the phone's Gamepad mode the Motion chips follow the [control catalogue](../spec/CATALOGUE.md): **Aim** (gyro turn rate), **Steer** (tilt angle) and **Point** (a Wii-style pointer). Hold a chip for its options (route, sensitivity, deadzone jump, invert Y); the profile pill picks a profile (Default, Flight, Driving, Shooter, Pointer). The extension suggests a profile per site from `src/shared/sites.ts` (tesana.com and play.tesana.ai suggest Flight); the phone applies it unless you chose one yourself.

| Utility | Page receives |
|---|---|
| Aim → right stick (Default, Flight) | right-stick values that clear the game's deadzone with a small turn |
| Aim → mouse (Shooter) | `movementX`/`movementY` under pointer lock; the right stick otherwise |
| Steer → fly (Flight) | tilt = right-stick X, tip forward/back = right-stick Y, like a yoke |
| Steer → wheel (Default, Driving) | tilt = left-stick X |
| Point | a lime cursor where the phone points; A clicks (`pointerdown`, `mousedown`, `up`, `click`) and holding B drags, through frames and open shadow roots; under pointer lock the pointer becomes relative mouse movement and no cursor is drawn; with the edge turn on, the right stick deflects toward the edge the cursor is near |

While A or B click at the cursor they are not also gamepad buttons.

### Pages with frames

The controller is visible in every bridged frame, as a real one would be. Keys go only to the focused frame. 3D input goes to the frame with the largest canvas.

## Permissions

| Permission | Why |
|---|---|
| `offscreen` | An MV3 service worker can't hold a WebRTC connection, so an offscreen document (reason `WEB_RTC`) keeps the link to the phone. |
| `storage` | Remembers the chosen mode. Session storage, cleared when the browser closes, holds the controlled tab and link status for the popup. |
| `activeTab` | Clicking the toolbar icon grants access to the current tab only (its address for the popup, and script injection), so **This tab** needs no broad host access. |
| `scripting` | Injects the bridge (isolated world) and the page script (main world) into the controlled tab. |
| `https://obpal.blackboxes.net/*` | Signaling and TURN credentials for the phone link. |
| `<all_urls>` (optional, **All sites**) | Requested only when you turn it on. It reaches game iframes served from other domains, and keeps control across navigation and newly added frames. |

Scripts run only in the tab you enabled:
- While **All sites** is on and a tab is controlled, a small bridge loads at page start in other tabs too, but it stays idle there.
- The popup's toggle revokes the permission again. So does the site access setting on the extension's details page.

The extension has no analytics and loads no remote code:
- Extension pages use `script-src 'self'`.
- Their network access is limited to the ob.Pal service.

## Limitations

**Browser limits**
- **Synthetic events are untrusted** (`isTrusted` is false).
  - Sites that check it ignore them: some games, anti-cheat, many login and payment forms.
  - Browser default actions don't run: arrow keys don't scroll, keys don't type into inputs, and right-click opens no menu.
- **Pointer lock and fullscreen can't be triggered.** Both need a real user gesture. Click the game yourself to lock the pointer; mouse-look then uses `movementX`/`movementY`.

**Frames and pages**
- **Cross-origin iframes need All sites.** Most itch.io games and many embeds run in one. Without the permission, only frames from the tab's own origin are reached.
- **Some pages can't be controlled**: browser pages such as `chrome://`, extension stores, and other extensions' pages. `file://` pages work only after you turn on "Allow access to file URLs".

**Games**
- **Cloud gaming in the browser works through Controller mode.** Xbox Cloud Gaming, GeForce NOW and similar services read the Gamepad API, which has no `isTrusted`.
- A game that saved a reference to `navigator.getGamepads` before the page script arrived won't see the pad. Reload with control on: with All sites, the bridge loads at page start.

**Everything else**
- If the browser window isn't focused, keys go to the top frame.
- Canvases inside closed shadow roots can't be found. For those pages, the element under the viewport centre is used.
- One phone and one controlled tab at a time.

## How it works

```
phone (ob.Pal controller PWA)
   │ WebRTC DataChannels (signaling via obpal.blackboxes.net)
   ▼
offscreen.html: @obpal/host Remote; samples remote.pad + remote.consume() at 60 Hz
   │ runtime port per frame (compact frames; the pad goes to every frame, keys/3D to one elected frame)
   ▼
bridge.js (isolated world, every permitted frame of the controlled tab)
   │ window.postMessage, channel "obpal-link/v1" + session id, same window and origin only
   ▼
page.js (main world): getGamepads shim, pointer/wheel synthesis, key/mouse synthesis
```

**Service worker (`background.js`)**
- Creates the offscreen document.
- Injects the bridge when you enable a tab. Each bridge then asks the worker for the page script in its own frame.
- Stores the mode and the controlled tab.

**Validation**
- Every hop validates what it receives (`src/shared/messages.ts`).
- The service worker also checks who sent each request: pages may only ask about their own tab.

## Development

| Command | What it does |
|---|---|
| `pnpm run build:extension` | Runs the Vite build (see below). |
| `pnpm run typecheck` | Includes `extension/tsconfig.json`. |
| `pnpm test` | `tests/extension.test.ts` covers key mapping and hysteresis, the 3D drag and wheel synthesis, message validation and frame routing. |
| `node extension/scripts/icons.mjs [outDir]` | Renders the 16/32/48/128 px icons from `public/favicon.svg` with sharp. |

The build does the following:
- Builds the popup, the offscreen document and the service worker as ES modules.
- Builds the two content scripts as self-contained IIFEs.
- Writes `manifest.json` and renders the PNG icons.
- Fails unless the manifest is MV3 and every file it references exists.

| Path | Contents |
|---|---|
| `src/background.ts` | Service worker: routing, per-tab enablement, injection, badge |
| `src/offscreen.ts` | Phone link and 60 Hz sampler (`src/ticker.ts` is its worker clock) |
| `src/popup/` | Popup UI (uses `src/ui/icons.ts` and `src/styles/base.css` from the app) |
| `src/content/bridge.ts` | Isolated-world bridge |
| `src/content/page.ts` | Main-world page script |
| `src/shared/` | Pure logic: constants, messages and validation, routing, key mapping, 3D synthesis |
